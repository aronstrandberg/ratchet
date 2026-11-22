import { expect, test } from "bun:test"
import { Effect, Option } from "effect"
import { Answer, DecisionKind, type DecisionSpec } from "../protocol/decision.ts"
import { SessionId } from "../protocol/ids.ts"
import { SessionFact, SessionOrigin } from "../protocol/session.ts"
import * as Decisions from "./decisions.ts"
import * as Index from "./index-store.ts"
import * as Tasks from "./tasks.ts"
import * as TestHub from "./test-hub.ts"

const run = <A, E>(program: Effect.Effect<A, E, TestHub.Services>) =>
  Effect.runPromise(program.pipe(Effect.provide(TestHub.layer())))

const session = SessionId.make("ses_a")

const spec = (kind: DecisionKind): DecisionSpec => ({
  question: "Which pool gets the new workers?",
  brief: "ci-amd64 is short of workers at the morning peak. [The queue](https://example.com/q) waits 9 minutes.",
  options: [
    { label: "ci-amd64", effect: "Shorter queues at the peak. Costs 12 more nodes." },
    { label: "golink", effect: "Faster links. The peak stays as it is." },
  ],
  recommended: "ci-amd64",
  reason: "The queue at the peak is the larger cost.",
  kind,
})

const reversible = spec(DecisionKind.cases.Reversible.make({ undo: "Revert the pool's replica count." }))
const waits = spec(DecisionKind.cases.Waits.make({ blocks: "The pool change and its rollout." }))

/** A session the hub knows, and the services a test drives. */
const setUp = Effect.gen(function* () {
  const tasks = yield* Tasks.Service

  yield* tasks.observe([
    SessionFact.cases.Opened.make({
      session,
      title: "Grow the worker pools",
      origin: SessionOrigin.cases.Root.make({}),
      running: false,
      subagents: [],
      questions: [],
    }),
  ])

  return { tasks, decisions: yield* Decisions.Service, index: yield* Index.Service, outside: yield* TestHub.Control }
})

test("a reversible decision leaves the task as it was, and confirming the recommended option wakes nobody", () =>
  run(
    Effect.gen(function* () {
      const { tasks, decisions, index, outside } = yield* setUp
      const raised = yield* decisions.raise(session, reversible, Option.none())

      expect(raised.meanwhile).toStartWith('Act on "ci-amd64" now.')
      expect((yield* tasks.current(session)).state).toBe("Idle")
      expect((yield* index.inbox).defaulted.map((row) => row.id)).toEqual([raised.decision])

      yield* decisions.answer(raised.decision, Answer.cases.Chose.make({ option: "ci-amd64" }), "")

      expect(yield* outside.wakes).toEqual([])
      expect((yield* tasks.current(session)).decisions).toEqual([])
      expect((yield* index.inbox).closed.map((row) => row.ending?._tag)).toEqual(["Answered"])
    }),
  ))

test("a decision the session waits on puts the task on me, and my answer wakes the session once", () =>
  run(
    Effect.gen(function* () {
      const { tasks, decisions, index, outside } = yield* setUp
      const raised = yield* decisions.raise(session, waits, Option.none())

      expect((yield* tasks.current(session)).state).toBe("NeedsMe")
      expect((yield* index.inbox).waiting.map((row) => [row.id, row.taskTitle])).toEqual([
        [raised.decision, "Grow the worker pools"],
      ])

      yield* decisions.answer(raised.decision, Answer.cases.Chose.make({ option: "golink" }), "Links first.")
      const again = yield* Effect.flip(decisions.answer(raised.decision, Answer.cases.Chose.make({ option: "golink" }), ""))

      expect(again._tag).toBe("DecisionClosed")
      expect((yield* tasks.current(session)).state).toBe("Idle")
      expect((yield* outside.wakes).map((wake) => wake.text)).toEqual([
        [
          `Ratchet: the user answered your decision "Which pool gets the new workers?" (${raised.decision}).`,
          '- The user chose "golink".',
          "- Their note: Links first.",
          "Go on with what waited on this answer: The pool change and its rollout.",
          'It belongs to your task "Grow the worker pools".',
        ].join("\n"),
      ])
    }),
  ))

test("a spec whose recommendation is not an option is refused, and so is an answer that names no option", () =>
  run(
    Effect.gen(function* () {
      const { decisions, index } = yield* setUp
      const refused = yield* Effect.flip(decisions.raise(session, { ...waits, recommended: "both" }, Option.none()))

      expect(refused._tag).toBe("InvalidDecision")

      const raised = yield* decisions.raise(session, waits, Option.none())
      const unknown = yield* Effect.flip(decisions.answer(raised.decision, Answer.cases.Chose.make({ option: "arm64" }), ""))

      expect(unknown._tag).toBe("UnknownOption")
      expect((yield* index.inbox).waiting.map((row) => row.id)).toEqual([raised.decision])
    }),
  ))

test("a new decision supersedes an open one, and the session closes a decision the user answered in its window", () =>
  run(
    Effect.gen(function* () {
      const { tasks, decisions, index, outside } = yield* setUp
      const first = yield* decisions.raise(session, waits, Option.none())
      const second = yield* decisions.raise(session, reversible, Option.some(first.decision))

      expect((yield* tasks.current(session)).decisions.map((decision) => decision.id)).toEqual([second.decision])

      const stranger = yield* Effect.flip(decisions.close(SessionId.make("ses_b"), second.decision, Option.none(), "No"))
      expect(stranger._tag).toBe("NoTask")

      yield* decisions.close(session, second.decision, Option.some("golink"), "Said so in the session.")

      expect(yield* outside.wakes).toEqual([])
      expect((yield* index.inbox).closed.map((row) => [row.id, row.ending?._tag])).toEqual([
        [second.decision, "Answered"],
        [first.decision, "Superseded"],
      ])
    }),
  ))
