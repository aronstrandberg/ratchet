import { expect, test } from "bun:test"
import { Effect } from "effect"
import { Machine } from "effect-machine"
import type { Check, PullRequestFacts } from "../protocol/pull-request.ts"
import { PullRequestEvent, PullRequestState, changes, pullRequestMachine } from "./pull-request.ts"

const facts = (over: Partial<PullRequestFacts> = {}): PullRequestFacts => ({
  ref: { owner: "o", repo: "r", number: 1 },
  title: "A change",
  state: "open",
  draft: false,
  head: "aaa",
  mergeable: "mergeable",
  reviewDecision: null,
  queued: false,
  checks: [],
  threads: [],
  reviews: [],
  viewer: "me",
  ...over,
})

const check = (name: string, state: Check["state"], required = true): Check => ({ name, state, required })

/** The changes each observation produces, in order, starting from a pull request nobody has seen. */
const observe = (...observations: ReadonlyArray<PullRequestFacts>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      let state: PullRequestState = PullRequestState.Unseen
      const all: Array<ReadonlyArray<string>> = []
      for (const observation of observations) {
        const next: PullRequestState = yield* Machine.replay(pullRequestMachine, [PullRequestEvent.Observed({ facts: observation })], { from: state })
        all.push(changes(state, next).map((change) => change._tag))
        state = next
      }
      return all
    }),
  )

test("CI on one head reports its first failure and its end, and nothing in between", async () => {
  const seen = await observe(
    facts({ checks: [check("a", "pending"), check("b", "pending"), check("c", "pending")] }),
    facts({ checks: [check("a", "failure"), check("b", "pending"), check("c", "pending")] }),
    facts({ checks: [check("a", "failure"), check("b", "failure"), check("c", "pending")] }),
    facts({ checks: [check("a", "failure"), check("b", "failure"), check("c", "success")] }),
    facts({ checks: [check("a", "failure"), check("b", "failure"), check("c", "success")] }),
  )
  expect(seen).toEqual([[], ["CiFailing"], [], ["CiFinished"], []])
})

test("an optional check that fails or stays pending does not hold or fail CI", async () => {
  const seen = await observe(
    facts({ checks: [check("required", "pending"), check("optional", "pending", false)] }),
    facts({ checks: [check("required", "success"), check("optional", "failure", false)] }),
  )
  expect(seen).toEqual([[], ["CiFinished"]])
})

test("a push starts CI over, so the new head can report a failure again", async () => {
  const seen = await observe(
    facts({ head: "aaa", checks: [check("a", "failure")] }),
    facts({ head: "bbb", checks: [check("a", "pending")] }),
    facts({ head: "bbb", checks: [check("a", "failure")] }),
  )
  expect(seen).toEqual([[], ["HeadMoved"], ["CiFinished"]])
})

test("my own review and thread are not changes, and another person's are", async () => {
  const seen = await observe(
    facts(),
    facts({
      reviews: [
        { id: "r1", author: "me", state: "commented" },
        { id: "r2", author: "reviewer", state: "changes_requested" },
      ],
      threads: [
        { id: "t1", resolved: false, author: "me", lastAuthor: "me" },
        { id: "t2", resolved: false, author: "reviewer", lastAuthor: "reviewer" },
      ],
    }),
  )
  expect(seen).toEqual([[], ["ReviewSubmitted", "ThreadOpened"]])
})

test("leaving the merge queue without merging is reported, and merging is reported once", async () => {
  const seen = await observe(
    facts(),
    facts({ queued: true }),
    facts({ queued: false }),
    facts({ queued: true }),
    facts({ state: "merged" }),
    facts({ state: "merged" }),
  )
  expect(seen).toEqual([[], ["Queued"], ["Dequeued"], ["Queued"], ["Merged"], []])
})
