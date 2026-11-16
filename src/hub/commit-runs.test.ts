import { expect, test } from "bun:test"
import { Effect } from "effect"
import { Machine } from "effect-machine"
import type { CommitRunsFacts, Run } from "../protocol/runs.ts"
import { CommitRunsEvent, CommitRunsState, changes, commitRunsMachine, describe, repeats, settles } from "./commit-runs.ts"

const minute = 60_000
const created = 1_000_000_000
const commit = "ab12".repeat(10)

/** A stack's run of the followed commit. `over` changes which run it is, or what it holds. */
const run = (stack: string, state: string, over: Partial<Run> = {}): Run => ({
  id: `${stack}-1`,
  stack,
  state,
  needsApproval: false,
  url: `https://spacelift.test/stack/${stack}/run/${stack}-1`,
  commit,
  createdAt: created,
  updatedAt: created,
  delta: null,
  ...over,
})

const facts = (...runs: ReadonlyArray<Run>): CommitRunsFacts => ({
  ref: { owner: "o", repo: "r", commit },
  title: "Give the role a binding (#12)",
  runs,
})

/** What each observation changes, in order, starting from runs nobody has seen. `at` is minutes after the runs were created. */
const observe = (...observations: ReadonlyArray<{ readonly at: number; readonly facts: CommitRunsFacts }>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      let state: CommitRunsState = CommitRunsState.Unseen({ subscribers: [] })
      const all: Array<ReadonlyArray<string>> = []

      for (const observation of observations) {
        const event = CommitRunsEvent.Observed({ facts: observation.facts, at: created + observation.at * minute })
        const next: CommitRunsState = yield* Machine.replay(commitRunsMachine, [event], { from: state })
        all.push(changes(state, next).map(describe))
        state = next
      }

      return all
    }),
  )

const waiting = "The run on iam waits for someone to confirm it. Its plan adds 2, changes 0 and deletes 1. https://spacelift.test/stack/iam/run/iam-1"
const plan = { delta: { add: 2, change: 0, delete: 1 } }

test("a run that waits to be confirmed is told once, with what its plan changes, and told again when it has finished", async () => {
  const seen = await observe(
    { at: 1, facts: facts(run("iam", "PLANNING"), run("dns", "FINISHED")) },
    { at: 2, facts: facts(run("iam", "UNCONFIRMED", plan), run("dns", "FINISHED")) },
    { at: 3, facts: facts(run("iam", "UNCONFIRMED", plan), run("dns", "FINISHED")) },
    { at: 90, facts: facts(run("iam", "APPLYING", plan), run("dns", "FINISHED")) },
    { at: 91, facts: facts(run("iam", "FINISHED", { ...plan, updatedAt: created + 91 * minute }), run("dns", "FINISHED")) },
  )

  // The stack that finished without waiting is not told about.
  expect(seen).toEqual([[], [waiting], [], [], ["The run on iam has finished."]])
})

test("a run that a policy holds for an approval, one that failed and one that was discarded are each told", async () => {
  const seen = await observe({
    at: 1,
    facts: facts(run("dns", "DISCARDED"), run("iam", "QUEUED", { needsApproval: true }), run("net", "FAILED")),
  })

  expect(seen).toEqual([
    [
      "The run on dns was discarded, so its plan is not applied: https://spacelift.test/stack/dns/run/dns-1",
      "The run on iam waits for an approval. https://spacelift.test/stack/iam/run/iam-1",
      "The run on net failed: https://spacelift.test/stack/net/run/net-1",
    ],
  ])
})

test("a failed run that is tried again is told when the new run waits, and when it finishes", async () => {
  const retry = { id: "iam-2", url: "https://spacelift.test/stack/iam/run/iam-2" }

  const seen = await observe(
    { at: 1, facts: facts(run("iam", "FAILED")) },
    { at: 2, facts: facts(run("iam", "UNCONFIRMED", retry)) },
    { at: 3, facts: facts(run("iam", "FINISHED", retry)) },
  )

  expect(seen).toEqual([
    ["The run on iam failed: https://spacelift.test/stack/iam/run/iam-1"],
    ["The run on iam waits for someone to confirm it. https://spacelift.test/stack/iam/run/iam-2"],
    ["The run on iam has finished."],
  ])
})

test("the runs settle a quarter of an hour after the last of them changed, and not while one waits", async () => {
  const done = facts(run("iam", "FINISHED", { updatedAt: created + 60 * minute }))
  const held = { title: done.title, runs: done.runs, told: [], subscribers: [] }

  expect(settles(done.runs, created + 74 * minute)).toBe(false)
  expect(settles(done.runs, created + 75 * minute)).toBe(true)
  expect(repeats(CommitRunsState.Running(held), done, created + 74 * minute)).toBe(true)
  expect(repeats(CommitRunsState.Running(held), done, created + 75 * minute)).toBe(false)

  // A run that nobody confirms is followed for a week.
  const unconfirmed = [run("iam", "UNCONFIRMED")]
  expect(settles(unconfirmed, created + 6 * 24 * 60 * minute)).toBe(false)
  expect(settles(unconfirmed, created + 7 * 24 * 60 * minute)).toBe(true)
})
