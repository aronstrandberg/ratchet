import { CloudflareCluster } from "@effect/platform-cloudflare"
import { Effect, Layer, Option, Schema } from "effect"
import { PersistenceError, VersionConflictError } from "effect-machine"
import {
  PersistenceAdapter,
  type PersistedEvent,
  type PersistenceAdapterInterface,
  type PersistenceKey,
  type Snapshot,
} from "effect-machine/cluster"
import type { SqlClient } from "effect/sql"

/** The schemas a machine's state and events are stored with. */
export interface MachineCodec {
  readonly state: Schema.Codec<any, any>
  readonly event: Schema.Codec<any, any>
}

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
 * Stores each machine's snapshots and journal in the SQLite database of the Durable Object that runs it.
 *
 * `codecs` maps an entity type to the schemas of its machine. A type without a codec fails every operation.
 */
export const layerSqlite = (codecs: Record<string, MachineCodec>): Layer.Layer<PersistenceAdapter> => {
  const codecFor = (key: PersistenceKey) => {
    const codec = codecs[key.entityType]
    return codec === undefined
      ? Effect.fail(new PersistenceError({ message: `no codec for entity type ${key.entityType}` }))
      : Effect.succeed({
          state: Schema.toCodecJson(codec.state),
          event: Schema.toCodecJson(codec.event),
        })
  }
  const entity = (key: PersistenceKey) => `${key.entityType}/${key.entityId}`
  // The client exists only inside an entity's Durable Object, so each call resolves it.
  const client = Effect.tap(CloudflareCluster.DurableObjectSqlClient.orDie, tables).pipe(
    Effect.mapError(failed("create tables")),
  )

  const adapter: PersistenceAdapterInterface = {
    saveSnapshot: (key, snapshot) =>
      Effect.gen(function* () {
        const sql = yield* client
        const codec = yield* codecFor(key)
        const state = JSON.stringify(yield* Schema.encodeUnknownEffect(codec.state)(snapshot.state))
        yield* sql`INSERT INTO machine_snapshot (entity, state, version, timestamp)
          VALUES (${entity(key)}, ${state}, ${snapshot.version}, ${snapshot.timestamp})
          ON CONFLICT (entity) DO UPDATE SET state = excluded.state, version = excluded.version,
            timestamp = excluded.timestamp`
      }).pipe(Effect.mapError(failed("save snapshot"))),

    loadSnapshot: (key) =>
      Effect.gen(function* () {
        const sql = yield* client
        const codec = yield* codecFor(key)
        const rows = yield* sql<{ state: string; version: number; timestamp: number }>`
          SELECT state, version, timestamp FROM machine_snapshot WHERE entity = ${entity(key)}`
        const row = rows[0]
        if (row === undefined) return Option.none<Snapshot<unknown>>()
        const state = yield* Schema.decodeUnknownEffect(codec.state)(JSON.parse(row.state))
        return Option.some<Snapshot<unknown>>({ state, version: row.version, timestamp: row.timestamp })
      }).pipe(Effect.mapError(failed("load snapshot"))),

    appendEvents: (key, events, expectedVersion) =>
      Effect.gen(function* () {
        const sql = yield* client
        const codec = yield* codecFor(key)
        const rows = yield* sql<{ version: number | null }>`
          SELECT MAX(version) AS version FROM machine_event WHERE entity = ${entity(key)}`
        const actual = rows[0]?.version ?? null
        // An empty journal says nothing about the version: a snapshot may hold it.
        if (actual !== null && actual !== expectedVersion) {
          return yield* new VersionConflictError({ expected: expectedVersion, actual })
        }
        for (const persisted of events) {
          const event = JSON.stringify(yield* Schema.encodeUnknownEffect(codec.event)(persisted.event))
          yield* sql`INSERT INTO machine_event (entity, version, event, timestamp)
            VALUES (${entity(key)}, ${persisted.version}, ${event}, ${persisted.timestamp})`
        }
      }).pipe(
        Effect.mapError((cause) => (cause instanceof VersionConflictError ? cause : failed("append events")(cause))),
      ),

    loadEvents: (key, afterVersion) =>
      Effect.gen(function* () {
        const sql = yield* client
        const codec = yield* codecFor(key)
        const rows = yield* sql<{ event: string; version: number; timestamp: number }>`
          SELECT event, version, timestamp FROM machine_event
          WHERE entity = ${entity(key)} AND version > ${afterVersion ?? 0} ORDER BY version`
        const events: Array<PersistedEvent<unknown>> = []
        for (const row of rows) {
          const event = yield* Schema.decodeUnknownEffect(codec.event)(JSON.parse(row.event))
          events.push({ event, version: row.version, timestamp: row.timestamp })
        }
        return events
      }).pipe(Effect.mapError(failed("load events"))),
  }
  return Layer.succeed(PersistenceAdapter, adapter)
}
