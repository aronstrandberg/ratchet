import { expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Option } from "effect"
import { Machine } from "effect-machine"
import { PersistenceAdapter } from "effect-machine/cluster"
import { SqlClient } from "effect/sql"
import * as Persistence from "./persistence.ts"
import { TaskEvent, TaskState, taskMachine } from "./task.ts"

const key = { entityType: "Task", entityId: "t1" }

const withStore = <A, E>(use: (adapter: typeof PersistenceAdapter.Service, sql: SqlClient.SqlClient) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const layer = Persistence.layerSqlite({ Task: Persistence.journaled(taskMachine) }, Effect.succeed(sql))
    return yield* Effect.flatMap(PersistenceAdapter, (adapter) => use(adapter, sql)).pipe(Effect.provide(layer))
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" })), Effect.runPromise)

const journal = (count: number) => [
  TaskEvent.Created({ title: "first", parent: null, session: "ses_1" }),
  ...Array.from({ length: count - 1 }, (_, i) => TaskEvent.Renamed({ title: `title ${i + 2}` })),
]

test("folding a long journal into a snapshot loses no accepted event", () =>
  withStore((adapter, sql) =>
    Effect.gen(function* () {
      const events = journal(450)
      for (const [index, event] of events.entries()) {
        yield* adapter.appendEvents(key, [{ event, version: index + 1, timestamp: index }], index)
      }
      const rows = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM machine_event`
      expect(rows[0]?.count).toBeLessThan(200)

      // A wake reads the snapshot, then replays what the journal holds after it.
      const snapshot = Option.getOrThrow(yield* adapter.loadSnapshot(key))
      const rest = yield* adapter.loadEvents(key, snapshot.version)
      const woken = yield* Machine.replay(taskMachine, rest.map((e) => e.event as typeof TaskEvent.Type), {
        from: snapshot.state as TaskState,
      })
      const expected = yield* Machine.replay(taskMachine, events)
      expect(woken).toEqual(expected)
      expect(snapshot.version + rest.length).toBe(450)
    }),
  ))

test("an append at a stale version is refused after the journal was folded away", () =>
  withStore((adapter) =>
    Effect.gen(function* () {
      for (const [index, event] of journal(200).entries()) {
        yield* adapter.appendEvents(key, [{ event, version: index + 1, timestamp: index }], index)
      }
      const stale = yield* Effect.flip(
        adapter.appendEvents(key, [{ event: TaskEvent.Renamed({ title: "late" }), version: 200, timestamp: 0 }], 199),
      )
      expect(stale._tag).toBe("VersionConflictError")
    }),
  ))
