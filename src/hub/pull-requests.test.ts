import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { TestRunner } from "effect/cluster"
import { EntityMachine } from "effect-machine/cluster"
import type { Check, PullRequestFacts } from "../protocol/pull-request.ts"
import * as Commands from "./commands.ts"
import * as Facts from "./facts.ts"
import { PullRequestEntity, pullRequestMachine } from "./pull-request.ts"
import * as PullRequests from "./pull-requests.ts"
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
  EntityMachine.layer(PullRequestEntity, pullRequestMachine),
).pipe(Layer.provideMerge(TestRunner.layer))

const run = <A, E>(program: Effect.Effect<A, E, Layer.Success<typeof cells>>) =>
  Effect.runPromise(program.pipe(Effect.provide(cells)))

const ref = { owner: "o", repo: "r", number: 1 }

const facts = (over: Partial<PullRequestFacts> = {}): PullRequestFacts => ({
  ref,
  title: "A change",
  state: "open",
  draft: false,
  head: "aaaaaaaaaaaa",
  mergeable: "mergeable",
  reviewDecision: null,
  queued: false,
  checks: [],
  threads: [],
  reviews: [],
  viewer: "me",
  ...over,
})

const check = (name: string, state: Check["state"]): Check => ({ name, state, required: true })

const open = (session: string) =>
  Facts.apply(noIndex, {
    _tag: "Opened",
    session,
    title: session,
    origin: { _tag: "Root" },
    running: false,
    subagents: [],
    questions: [],
  })

const everyone = () => true

test("a failed delivery keeps the wake-up, and the next delivery sends it once", () =>
  run(
    Effect.gen(function* () {
      yield* open("ses_owner")
      const { task } = yield* PullRequests.register(noIndex, "ses_owner", ref, "owns")
      yield* PullRequests.observe(noIndex, facts({ checks: [check("build", "pending")] }), everyone)
      const observed = yield* PullRequests.observe(noIndex, facts({ checks: [check("build", "failure")] }), everyone)
      expect(observed.queued).toEqual([task])

      const sent: Array<string> = []
      const down = () => Effect.fail("OpenCode is down")
      const up = (session: string, text: string) => Effect.sync(() => void sent.push(`${session}: ${text}`))
      expect(yield* PullRequests.deliver(noIndex, task, down)).toBe(0)
      expect(yield* PullRequests.deliver(noIndex, task, up)).toBe(1)
      expect(yield* PullRequests.deliver(noIndex, task, up)).toBe(0)
      expect(sent).toHaveLength(1)
      expect(sent[0]).toContain("ses_owner: Ratchet: pull request o/r#1 changed.")
      expect(sent[0]).toContain("CI finished on aaaaaaa with failing required checks: build.")
    }),
  ))

test("a task that waits on a pull request hears its merge and not its CI or reviews", () =>
  run(
    Effect.gen(function* () {
      yield* open("ses_waiter")
      const { task } = yield* PullRequests.register(noIndex, "ses_waiter", ref, "waits_on")
      yield* PullRequests.observe(noIndex, facts({ checks: [check("build", "pending")] }), everyone)

      const noisy = yield* PullRequests.observe(
        noIndex,
        facts({
          checks: [check("build", "failure")],
          reviews: [{ id: "r1", author: "reviewer", state: "changes_requested" }],
        }),
        everyone,
      )

      expect(noisy.changes).toEqual(["CiFinished", "ReviewSubmitted"])
      expect(noisy.queued).toEqual([])
      const merged = yield* PullRequests.observe(noIndex, facts({ state: "merged" }), everyone)
      expect(merged.queued).toEqual([task])
    }),
  ))

test("a session that may not be woken gets no wake-up queued", () =>
  run(
    Effect.gen(function* () {
      yield* open("ses_quiet")
      yield* PullRequests.register(noIndex, "ses_quiet", ref, "owns")
      yield* PullRequests.observe(noIndex, facts(), everyone)
      const merged = yield* PullRequests.observe(noIndex, facts({ state: "merged" }), () => false)
      expect(merged.changes).toEqual(["Merged"])
      expect(merged.queued).toEqual([])
    }),
  ))

test("reporting that a pull request waits on me puts its task in front of me", () =>
  run(
    Effect.gen(function* () {
      yield* open("ses_done")
      yield* PullRequests.register(noIndex, "ses_done", ref, "owns")
      expect((yield* Commands.current("ses_done")).state).toBe("Idle")
      yield* PullRequests.setStatus(noIndex, "ses_done", ref, "waiting-user", "Ready for your review.")
      expect((yield* Commands.current("ses_done")).state).toBe("NeedsMe")

      const unknown = yield* Effect.flip(
        PullRequests.setStatus(noIndex, "ses_done", { ...ref, number: 2 }, "ready", "Nothing left."),
      )

      expect(unknown._tag).toBe("NotRegistered")
    }),
  ))
