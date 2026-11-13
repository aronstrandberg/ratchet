import { Effect, Layer, Option, Schema } from "effect"
import { Machine, PersistenceError, VersionConflictError } from "effect-machine"
import {
  PersistenceAdapter,
  type PersistedEvent,
  type PersistenceAdapterInterface,
  type PersistenceKey,
  type Snapshot,
} from "effect-machine/cluster"
import type { SqlClient, SqlError } from "effect/sql"

/**
 * One machine's snapshots and journal in SQLite, encoded with the machine's own schemas.
 *
 * `entity` names the cell: its entity type and ID. Every method fails when a stored or given value does not
 * match the machine's schemas.
 */
export interface Journaled {
  readonly readSnapshot: (
    sql: SqlClient.SqlClient,
    entity: string,
  ) => Effect.Effect<Option.Option<Snapshot<unknown>>, StoreFailure>
  readonly readEvents: (
    sql: SqlClient.SqlClient,
    entity: string,
    after: number,
  ) => Effect.Effect<Array<PersistedEvent<unknown>>, StoreFailure>
  readonly writeSnapshot: (
    sql: SqlClient.SqlClient,
    entity: string,
    snapshot: Snapshot<unknown>,
  ) => Effect.Effect<void, StoreFailure>
  readonly appendEvent: (
    sql: SqlClient.SqlClient,
    entity: string,
    event: PersistedEvent<unknown>,
  ) => Effect.Effect<void, StoreFailure>
  /** Folds the journal into the snapshot and deletes the folded events, in one transaction. */
  readonly compact: (
    sql: SqlClient.SqlClient,
    entity: string,
  ) => Effect.Effect<Option.Option<Snapshot<unknown>>, StoreFailure>
}

/** What can go wrong in a machine's store: the database fails, or a value does not match the machine's schema. */
type StoreFailure = SqlError.SqlError | Schema.SchemaError

/** A machine's store in SQLite, typed inside by the machine's own state and events. */
export const journaled = <S extends { readonly _tag: string }, E extends { readonly _tag: string }>(
  // oxlint-disable-next-line typescript/no-explicit-any -- SAFETY: The store reads only the machine's state and event schemas and replays its transitions. The four parameters left open are the machine's guards, effects and context, which TypeScript cannot leave unnamed here without any.
  machine: Machine.Machine<S, E, never, any, any, void, any>,
): Journaled => {
  const state: Schema.Codec<S, Schema.Json> = Schema.toCodecJson(machine.stateSchema)
  const event: Schema.Codec<E, Schema.Json> = Schema.toCodecJson(machine.eventSchema)

  const readSnapshot = (sql: SqlClient.SqlClient, entity: string) =>
    Effect.gen(function* () {
      const rows = yield* sql<{ state: string; version: number; timestamp: number }>`
        SELECT state, version, timestamp FROM machine_snapshot WHERE entity = ${entity}`

      const row = rows[0]

      if (row === undefined) return Option.none<Snapshot<S>>()
      const decoded = yield* Schema.decodeUnknownEffect(state)(JSON.parse(row.state))

      return Option.some({ state: decoded, version: row.version, timestamp: row.timestamp })
    })

  const readEvents = (sql: SqlClient.SqlClient, entity: string, after: number) =>
    Effect.gen(function* () {
      const rows = yield* sql<{ event: string; version: number; timestamp: number }>`
        SELECT event, version, timestamp FROM machine_event
        WHERE entity = ${entity} AND version > ${after} ORDER BY version`

      const events: Array<PersistedEvent<E>> = []

      for (const row of rows) {
        const decoded = yield* Schema.decodeUnknownEffect(event)(JSON.parse(row.event))
        events.push({ event: decoded, version: row.version, timestamp: row.timestamp })
      }

      return events
    })

  const writeSnapshot = (sql: SqlClient.SqlClient, entity: string, snapshot: Snapshot<unknown>) =>
    Effect.gen(function* () {
      const encoded = JSON.stringify(yield* Schema.encodeUnknownEffect(state)(snapshot.state))
      yield* sql`INSERT INTO machine_snapshot (entity, state, version, timestamp)
        VALUES (${entity}, ${encoded}, ${snapshot.version}, ${snapshot.timestamp})
        ON CONFLICT (entity) DO UPDATE SET state = excluded.state, version = excluded.version,
          timestamp = excluded.timestamp`
    })

  const appendEvent = (sql: SqlClient.SqlClient, entity: string, persisted: PersistedEvent<unknown>) =>
    Effect.gen(function* () {
      const encoded = JSON.stringify(yield* Schema.encodeUnknownEffect(event)(persisted.event))
      yield* sql`INSERT INTO machine_event (entity, version, event, timestamp)
        VALUES (${entity}, ${persisted.version}, ${encoded}, ${persisted.timestamp})`
    })

  const compact = (sql: SqlClient.SqlClient, entity: string) =>
    Effect.gen(function* () {
      const snapshot = yield* readSnapshot(sql, entity)
      const events = yield* readEvents(sql, entity, Option.match(snapshot, { onNone: () => 0, onSome: (s) => s.version }))
      const last = events.at(-1)

      if (last === undefined) return snapshot

      const folded = {
        state: yield* Machine.replay(
          machine,
          events.map((persisted) => persisted.event),
          Option.match(snapshot, { onNone: () => ({}), onSome: (s) => ({ from: s.state }) }),
        ),
        version: last.version,
        timestamp: last.timestamp,
      }

      yield* sql.withTransaction(
        Effect.andThen(
          writeSnapshot(sql, entity, folded),
          sql`DELETE FROM machine_event WHERE entity = ${entity} AND version <= ${last.version}`,
        ),
      )

      return Option.some(folded)
    })

  return { readSnapshot, readEvents, writeSnapshot, appendEvent, compact }
}

/** A wake replays at most this many events before the journal is folded into a snapshot. */
const compactOnLoad = 50

/** A cell that never sleeps folds its journal after this many events. */
const compactOnAppend = 200

const failed = (operation: string) => (cause: unknown) =>
  new PersistenceError({ message: `${operation}: ${String(cause)}` })

const tables = (sql: SqlClient.SqlClient) =>
  Effect.all([
    sql`CREATE TABLE IF NOT EXISTS machine_snapshot (
      entity TEXT PRIMARY KEY, state TEXT NOT NULL, version INTEGER NOT NULL, timestamp INTEGER NOT NULL)`,
    sql`CREATE TABLE IF NOT EXISTS machine_event (
      entity TEXT NOT NULL, version INTEGER NOT NULL, event TEXT NOT NULL, timestamp INTEGER NOT NULL,
      PRIMARY KEY (entity, version))`,
  ])

/**
 * Stores each machine's snapshot and journal in the SQLite database `database` resolves to: on celld, the
 * database of the Durable Object that runs the machine.
 *
 * The journal is the record of what the cell accepted. A snapshot is the journal up to a version folded into
 * one state, written when the journal grows past a limit, so a wake never replays a cell's whole history.
 *
 * `machines` maps an entity type to its machine. A type without one fails every operation.
 */
export const layerSqlite = (
  machines: Record<string, Journaled>,
  database: Effect.Effect<SqlClient.SqlClient>,
): Layer.Layer<PersistenceAdapter> => {
  const machineFor = (key: PersistenceKey) => {
    const machine = machines[key.entityType]

    return machine === undefined
      ? Effect.fail(new PersistenceError({ message: `no machine for entity type ${key.entityType}` }))
      : Effect.succeed(machine)
  }

  const entity = (key: PersistenceKey) => `${key.entityType}/${key.entityId}`
  // On celld the database exists only inside an entity's Durable Object, so each call resolves it.
  const client = Effect.tap(database, tables)

  const pending = (sql: SqlClient.SqlClient, key: PersistenceKey) =>
    Effect.map(
      sql<{ count: number }>`SELECT COUNT(*) AS count FROM machine_event WHERE entity = ${entity(key)}`,
      (rows) => rows[0]?.count ?? 0,
    )

  /** The database and the machine of a cell. */
  const open = (key: PersistenceKey) => Effect.all({ sql: client, machine: machineFor(key) })

  const adapter: PersistenceAdapterInterface = {
    saveSnapshot: (key, snapshot) =>
      Effect.flatMap(open(key), ({ sql, machine }) => machine.writeSnapshot(sql, entity(key), snapshot)).pipe(
        Effect.mapError(failed("save snapshot")),
      ),

    loadSnapshot: (key) =>
      Effect.gen(function* () {
        const { sql, machine } = yield* open(key)

        if ((yield* pending(sql, key)) > compactOnLoad) return yield* machine.compact(sql, entity(key))

        return yield* machine.readSnapshot(sql, entity(key))
      }).pipe(Effect.mapError(failed("load snapshot"))),

    appendEvents: (key, events, expectedVersion) =>
      Effect.gen(function* () {
        const { sql, machine } = yield* open(key)

        const rows = yield* sql<{ version: number | null }>`
          SELECT MAX(version) AS version FROM (
            SELECT version FROM machine_event WHERE entity = ${entity(key)}
            UNION ALL SELECT version FROM machine_snapshot WHERE entity = ${entity(key)})`

        const actual = rows[0]?.version ?? 0

        if (actual !== expectedVersion) {
          return yield* new VersionConflictError({ expected: expectedVersion, actual })
        }

        for (const persisted of events) yield* machine.appendEvent(sql, entity(key), persisted)

        if ((yield* pending(sql, key)) >= compactOnAppend) yield* machine.compact(sql, entity(key))
      }).pipe(
        Effect.mapError((cause) => (cause instanceof VersionConflictError ? cause : failed("append events")(cause))),
      ),

    loadEvents: (key, afterVersion) =>
      Effect.flatMap(open(key), ({ sql, machine }) => machine.readEvents(sql, entity(key), afterVersion ?? 0)).pipe(
        Effect.mapError(failed("load events")),
      ),
  }

  return Layer.succeed(PersistenceAdapter, adapter)
}
