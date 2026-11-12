import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { TestRunner } from "effect/cluster"
import { EntityMachine } from "effect-machine/cluster"
import * as Commands from "./commands.ts"
import * as Facts from "./facts.ts"
import { SessionEntity, sessionMachine } from "./session.ts"
import { TaskEntity, taskMachine } from "./task.ts"

/** An index that accepts every write, for tests that only read the cells. */
const noIndex = {
  exec: async () => ({}),
  prepare: () => ({ bind: () => ({ run: async () => ({}) }) }),
} as unknown as D1Database

const cells = Layer.mergeAll(
  EntityMachine.layer(TaskEntity, taskMachine),
  EntityMachine.layer(SessionEntity, sessionMachine),
).pipe(Layer.provideMerge(TestRunner.layer))

const run = <A, E>(program: Effect.Effect<A, E, Layer.Success<typeof cells>>) =>
  Effect.runPromise(program.pipe(Effect.provide(cells)))

test("a session that starts a new task takes its running state, subagents and questions along", () =>
  run(
    Effect.gen(function* () {
      yield* Facts.apply(noIndex, {
        _tag: "Opened",
        session: "ses_a",
        title: "Fix the runner",
        origin: { _tag: "Root" },
        running: true,
        subagents: ["ses_watch", "ses_work"],
        questions: [{ id: "q1", kind: "form", title: "Which pool?" }],
      })
      yield* Commands.declareSubagent(noIndex, "ses_a", "ses_watch", "watching")

      const started = yield* Commands.start(noIndex, "ses_a", "Storage roller traces", "child")
      const left = yield* (yield* TaskEntity.client)(started.left).GetState()

      expect(started.task.parent).toBe(started.left)
      expect(started.task.state).toBe("NeedsMe")
      expect(started.task.subagents).toEqual([
        { session: "ses_watch", kind: "watching" },
        { session: "ses_work", kind: "working" },
      ])
      expect(started.task.questions).toEqual(["Which pool?"])
      // The task the session left holds nothing of it any more.
      expect(left._tag).toBe("Idle")
      expect((yield* Commands.current("ses_a")).id).toBe(started.task.id)
    }),
  ))

test("a task whose only running subagent watches is not shown as being worked on", () =>
  run(
    Effect.gen(function* () {
      yield* Facts.apply(noIndex, {
        _tag: "Opened",
        session: "ses_b",
        title: "Queue depth",
        origin: { _tag: "Root" },
        running: false,
        subagents: ["ses_watch"],
        questions: [],
      })
      expect((yield* Commands.current("ses_b")).state).toBe("Working")
      const declared = yield* Commands.declareSubagent(noIndex, "ses_b", "ses_watch", "watching")
      expect(declared.state).toBe("Watching")
      yield* Facts.apply(noIndex, { _tag: "Asked", of: "ses_b", question: { id: "p1", kind: "permission", title: "run" } })
      expect((yield* Commands.current("ses_b")).state).toBe("NeedsMe")
    }),
  ))
