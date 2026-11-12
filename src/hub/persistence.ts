import { Effect, Layer, Option, Schema } from "effect"
import { Machine, PersistenceError, VersionConflictError } from "effect-machine"
import {
  PersistenceAdapter,
  type PersistedEvent,
  type PersistenceAdapterInterface,
  type PersistenceKey,
  type Snapshot,
} from "effect-machine/cluster"
import type { SqlClient } from "effect/sql"

/** What the store needs from a machine: how to encode its state and events, and how to fold events into state. */
export interface Journaled {
  readonly state: Schema.Codec<any, any>
  readonly event: Schema.Codec<any, any>
  readonly initial: unknown
  readonly replay: (events: ReadonlyArray<unknown>, from: unknown) => Effect.Effect<unknown>
}

export const journaled = <S extends { readonly _tag: string }, E extends { readonly _tag: string }>(
  machine: Machine.Machine<S, E, never, any, any, void, any>,
): Journaled => ({
  state: machine.stateSchema,
  event: machine.eventSchema,
  initial: machine.initial,
  // The store decodes events and state with this machine's own schemas before it replays them.
  replay: (events, from) => Machine.replay(machine, events as ReadonlyArray<E>, { from: from as S }),
})

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
      : Effect.succeed({
          machine,
          state: Schema.toCodecJson(machine.state),
          event: Schema.toCodecJson(machine.event),
        })
  }

  const entity = (key: PersistenceKey) => `${key.entityType}/${key.entityId}`
  // On celld the database exists only inside an entity's Durable Object, so each call resolves it.
  const client = Effect.tap(database, tables)

  const readSnapshot = (sql: SqlClient.SqlClient, key: PersistenceKey) =>
    Effect.gen(function* () {
      const { state } = yield* machineFor(key)

      const rows = yield* sql<{ state: string; version: number; timestamp: number }>`
        SELECT state, version, timestamp FROM machine_snapshot WHERE entity = ${entity(key)}`

      const row = rows[0]

      if (row === undefined) return Option.none<Snapshot<unknown>>()
      const decoded = yield* Schema.decodeUnknownEffect(state)(JSON.parse(row.state))

      return Option.some({ state: decoded, version: row.version, timestamp: row.timestamp })
    })

  const readEvents = (sql: SqlClient.SqlClient, key: PersistenceKey, after: number) =>
    Effect.gen(function* () {
      const { event } = yield* machineFor(key)

      const rows = yield* sql<{ event: string; version: number; timestamp: number }>`
        SELECT event, version, timestamp FROM machine_event
        WHERE entity = ${entity(key)} AND version > ${after} ORDER BY version`

      const events: Array<PersistedEvent<unknown>> = []

      for (const row of rows) {
        const decoded = yield* Schema.decodeUnknownEffect(event)(JSON.parse(row.event))
        events.push({ event: decoded, version: row.version, timestamp: row.timestamp })
      }

      return events
    })

  const writeSnapshot = (sql: SqlClient.SqlClient, key: PersistenceKey, snapshot: Snapshot<unknown>) =>
    Effect.gen(function* () {
      const { state } = yield* machineFor(key)
      const encoded = JSON.stringify(yield* Schema.encodeUnknownEffect(state)(snapshot.state))
      yield* sql`INSERT INTO machine_snapshot (entity, state, version, timestamp)
        VALUES (${entity(key)}, ${encoded}, ${snapshot.version}, ${snapshot.timestamp})
        ON CONFLICT (entity) DO UPDATE SET state = excluded.state, version = excluded.version,
          timestamp = excluded.timestamp`
    })

  /** Folds the journal into the snapshot and deletes the folded events, in one transaction. */
  const compact = (sql: SqlClient.SqlClient, key: PersistenceKey) =>
    Effect.gen(function* () {
      const { machine } = yield* machineFor(key)
      const snapshot = yield* readSnapshot(sql, key)
      const events = yield* readEvents(sql, key, Option.match(snapshot, { onNone: () => 0, onSome: (s) => s.version }))
      const last = events.at(-1)

      if (last === undefined) return snapshot
      const from = Option.match(snapshot, { onNone: () => machine.initial, onSome: (s) => s.state })

      const state = yield* machine.replay(
        events.map((persisted) => persisted.event),
        from,
      )

      const folded = { state, version: last.version, timestamp: last.timestamp }
      yield* sql.withTransaction(
        Effect.andThen(
          writeSnapshot(sql, key, folded),
          sql`DELETE FROM machine_event WHERE entity = ${entity(key)} AND version <= ${last.version}`,
        ),
      )

      return Option.some(folded)
    })

  const pending = (sql: SqlClient.SqlClient, key: PersistenceKey) =>
    Effect.map(
      sql<{ count: number }>`SELECT COUNT(*) AS count FROM machine_event WHERE entity = ${entity(key)}`,
      (rows) => rows[0]?.count ?? 0,
    )

  const adapter: PersistenceAdapterInterface = {
    saveSnapshot: (key, snapshot) =>
      Effect.flatMap(client, (sql) => writeSnapshot(sql, key, snapshot)).pipe(Effect.mapError(failed("save snapshot"))),

    loadSnapshot: (key) =>
      Effect.gen(function* () {
        const sql = yield* client

        if ((yield* pending(sql, key)) > compactOnLoad) return yield* compact(sql, key)

        return yield* readSnapshot(sql, key)
      }).pipe(Effect.mapError(failed("load snapshot"))),

    appendEvents: (key, events, expectedVersion) =>
      Effect.gen(function* () {
        const sql = yield* client
        const { event } = yield* machineFor(key)

        const rows = yield* sql<{ version: number | null }>`
          SELECT MAX(version) AS version FROM (
            SELECT version FROM machine_event WHERE entity = ${entity(key)}
            UNION ALL SELECT version FROM machine_snapshot WHERE entity = ${entity(key)})`

        const actual = rows[0]?.version ?? 0

        if (actual !== expectedVersion) {
          return yield* new VersionConflictError({ expected: expectedVersion, actual })
        }

        for (const persisted of events) {
          const encoded = JSON.stringify(yield* Schema.encodeUnknownEffect(event)(persisted.event))
          yield* sql`INSERT INTO machine_event (entity, version, event, timestamp)
            VALUES (${entity(key)}, ${persisted.version}, ${encoded}, ${persisted.timestamp})`
        }

        if ((yield* pending(sql, key)) >= compactOnAppend) yield* compact(sql, key)
      }).pipe(
        Effect.mapError((cause) => (cause instanceof VersionConflictError ? cause : failed("append events")(cause))),
      ),

    loadEvents: (key, afterVersion) =>
      Effect.flatMap(client, (sql) => readEvents(sql, key, afterVersion ?? 0)).pipe(
        Effect.mapError(failed("load events")),
      ),
  }

  return Layer.succeed(PersistenceAdapter, adapter)
}
