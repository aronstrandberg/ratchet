import { expect, test } from "bun:test"
import { Effect, Option } from "effect"
import { SessionId } from "../protocol/ids.ts"
import { SessionFact, SessionOrigin } from "../protocol/session.ts"
import * as Index from "./index-store.ts"
import * as Tasks from "./tasks.ts"
import * as TestHub from "./test-hub.ts"

const run = <A, E>(program: Effect.Effect<A, E, TestHub.Services>) =>
  Effect.runPromise(program.pipe(Effect.provide(TestHub.layer())))

const runner = SessionId.make("ses_a")
const watcher = SessionId.make("ses_watch")
const worker = SessionId.make("ses_work")

const opened = (session: SessionId, over: Partial<typeof SessionFact.cases.Opened.Type> = {}) =>
  SessionFact.cases.Opened.make({
    session,
    title: "Fix the runner",
    origin: SessionOrigin.cases.Root.make({}),
    running: false,
    subagents: [],
    questions: [],
    ...over,
  })

test("a session that starts a new task takes its running state, subagents and questions along", () =>
  run(
    Effect.gen(function* () {
      const tasks = yield* Tasks.Service
      const outside = yield* TestHub.Control

      yield* tasks.observe([
        opened(runner, {
          running: true,
          subagents: [watcher, worker],
          questions: [{ id: "q1", kind: "form", title: "Which pool?" }],
        }),
      ])
      yield* tasks.declareSubagent(runner, watcher, "watching")

      const started = yield* tasks.start(runner, "Storage roller traces", "child")

      expect(started.task.parent).toBe(started.left)
      expect(started.task.state).toBe("NeedsMe")
      expect(started.task.subagents).toEqual([
        { session: watcher, kind: "watching" },
        { session: worker, kind: "working" },
      ])
      expect(started.task.questions).toEqual(["Which pool?"])
      expect((yield* tasks.current(runner)).id).toBe(started.task.id)
      // The session's own metadata names the new task.
      expect(yield* outside.recorded).toEqual([{ session: runner, task: started.task.id }])

      // The board shows the new task below the one the session left, which holds nothing of it any more.
      const [left] = yield* Effect.flatMap(Index.Service, (index) => index.tree)
      expect(left).toMatchObject({ id: started.left, state: "Idle", children: [{ id: started.task.id, state: "NeedsMe" }] })
    }),
  ))

test("a task whose only running subagent watches is not shown as being worked on", () =>
  run(
    Effect.gen(function* () {
      const tasks = yield* Tasks.Service

      yield* tasks.observe([opened(runner, { subagents: [watcher] })])
      expect((yield* tasks.current(runner)).state).toBe("Working")

      const declared = yield* tasks.declareSubagent(runner, watcher, "watching")
      expect(declared.state).toBe("Watching")

      yield* tasks.observe([
        SessionFact.cases.Asked.make({ of: runner, question: { id: "p1", kind: "permission", title: "run" } }),
      ])
      expect((yield* tasks.current(runner)).state).toBe("NeedsMe")
    }),
  ))

test("a fork gets a child task of the task its origin works on", () =>
  run(
    Effect.gen(function* () {
      const tasks = yield* Tasks.Service
      const fork = SessionId.make("ses_fork")

      const [origin] = yield* tasks.observe([opened(runner)])
      yield* tasks.observe([opened(fork, { origin: SessionOrigin.cases.Fork.make({ of: runner }) })])

      expect((yield* tasks.current(fork)).parent).toBe(origin?.task ?? null)
    }),
  ))

test("a task a session started keeps its title when the session is seen again, and renames by ID", () =>
  run(
    Effect.gen(function* () {
      const tasks = yield* Tasks.Service

      yield* tasks.observe([opened(runner)])
      const started = yield* tasks.start(runner, "Storage roller traces", "child")

      // A reconnect reports the session again, with a new title. The title names the session's first task.
      yield* tasks.observe([opened(runner, { title: "Fix the runner, again" })])
      expect((yield* tasks.current(runner)).title).toBe("Storage roller traces")

      const first = yield* tasks.rename(runner, "Runner fixes", Option.some(started.left))
      expect(first).toMatchObject({ id: started.left, title: "Runner fixes" })

      const other = yield* tasks.observe([opened(watcher)])
      const refused = yield* Effect.flip(tasks.rename(watcher, "Not mine", Option.some(started.task.id)))
      expect(other).toHaveLength(1)
      expect(refused._tag).toBe("NotATaskOfSession")
    }),
  ))
