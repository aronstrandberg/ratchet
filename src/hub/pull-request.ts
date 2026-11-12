import { Schema } from "effect"
import { Event, Machine, State } from "effect-machine"
import { Check, PullRequestFacts, Review, Thread } from "../protocol/pull-request.ts"

/**
 * Where CI stands on one head commit. It moves forward only: `Running`, then `Failing` once a check has failed
 * while others still run, then `Finished`. So a head produces at most two CI changes: the first failure and the end.
 */
export const Ci = Schema.TaggedUnion({
  Running: {},
  Failing: { failed: Schema.Array(Schema.String) },
  Finished: { failed: Schema.Array(Schema.String) },
})
export type Ci = typeof Ci.Type

const open = {
  title: Schema.String,
  head: Schema.String,
  draft: Schema.Boolean,
  conflicting: Schema.Boolean,
  reviewDecision: PullRequestFacts.fields.reviewDecision,
  queued: Schema.Boolean,
  ci: Ci,
  threads: Schema.Array(Thread),
  reviews: Schema.Array(Review),
  viewer: Schema.String,
}

export const PullRequestState = State({
  Unseen: {},
  Open: open,
  Merged: { title: Schema.String },
  Closed: { title: Schema.String },
})
export type PullRequestState = typeof PullRequestState.Type

export const PullRequestEvent = Event({
  Observed: { facts: PullRequestFacts },
})

/** CI counts the checks the base branch requires, or every check when it requires none. */
const ci = (checks: ReadonlyArray<Check>): Ci => {
  const required = checks.filter((check) => check.required)
  const counted = required.length > 0 ? required : checks
  const failed = counted.filter((check) => check.state === "failure").map((check) => check.name)
  if (counted.some((check) => check.state === "pending")) {
    return failed.length > 0 ? { _tag: "Failing", failed } : { _tag: "Running" }
  }
  return { _tag: "Finished", failed }
}

const project = (facts: PullRequestFacts) => {
  if (facts.state === "merged") return PullRequestState.Merged({ title: facts.title })
  if (facts.state === "closed") return PullRequestState.Closed({ title: facts.title })
  return PullRequestState.Open({
    title: facts.title,
    head: facts.head,
    draft: facts.draft,
    conflicting: facts.mergeable === "conflicting",
    reviewDecision: facts.reviewDecision,
    queued: facts.queued,
    ci: ci(facts.checks),
    threads: facts.threads,
    reviews: facts.reviews,
    viewer: facts.viewer,
  })
}

export const pullRequestMachine = Machine.make({
  state: PullRequestState,
  event: PullRequestEvent,
  initial: PullRequestState.Unseen,
}).on(
  [PullRequestState.Unseen, PullRequestState.Open, PullRequestState.Merged, PullRequestState.Closed],
  PullRequestEvent.Observed,
  ({ event }) => project(event.facts),
)

/** Something that happened to a pull request, in terms a task can act on. */
export const Change = Schema.TaggedUnion({
  HeadMoved: { head: Schema.String },
  /** The first required check failed on this head while others still run. */
  CiFailing: { head: Schema.String, failed: Schema.Array(Schema.String) },
  /** CI ended on this head. `failed` is empty when it passed. */
  CiFinished: { head: Schema.String, failed: Schema.Array(Schema.String) },
  ReviewSubmitted: { author: Schema.String, state: Review.fields.state },
  ThreadOpened: { thread: Schema.String, author: Schema.String },
  ThreadResolved: { thread: Schema.String },
  Conflicting: {},
  Queued: {},
  /** Removed from the merge queue without merging. */
  Dequeued: {},
  Merged: {},
  Closed: {},
})
export type Change = typeof Change.Type

/**
 * What changed between two observations of a pull request.
 *
 * The first observation of an open pull request reports nothing: a task that attaches reads the state itself.
 * My own reviews and threads are not changes, because my sessions post under my login.
 */
export const changes = (before: PullRequestState, after: PullRequestState): ReadonlyArray<Change> => {
  if (after._tag === "Merged") return before._tag === "Merged" ? [] : [{ _tag: "Merged" }]
  if (after._tag === "Closed") return before._tag === "Closed" ? [] : [{ _tag: "Closed" }]
  if (after._tag !== "Open" || before._tag !== "Open") return []

  const found: Array<Change> = []
  const sameHead = before.head === after.head
  if (!sameHead) found.push({ _tag: "HeadMoved", head: after.head })

  const ciBefore = sameHead ? before.ci._tag : "Running"
  if (after.ci._tag === "Failing" && ciBefore === "Running") {
    found.push({ _tag: "CiFailing", head: after.head, failed: after.ci.failed })
  }
  if (after.ci._tag === "Finished" && ciBefore !== "Finished") {
    found.push({ _tag: "CiFinished", head: after.head, failed: after.ci.failed })
  }

  const seenReviews = new Set(before.reviews.map((review) => review.id))
  for (const review of after.reviews) {
    if (!seenReviews.has(review.id) && review.state !== "pending" && review.author !== after.viewer) {
      found.push({ _tag: "ReviewSubmitted", author: review.author, state: review.state })
    }
  }

  const threadsBefore = new Map(before.threads.map((thread) => [thread.id, thread]))
  for (const thread of after.threads) {
    const known = threadsBefore.get(thread.id)
    if (known === undefined && !thread.resolved && thread.author !== after.viewer) {
      found.push({ _tag: "ThreadOpened", thread: thread.id, author: thread.author })
    }
    if (known !== undefined && !known.resolved && thread.resolved) {
      found.push({ _tag: "ThreadResolved", thread: thread.id })
    }
  }

  if (after.conflicting && !before.conflicting) found.push({ _tag: "Conflicting" })
  if (after.queued && !before.queued) found.push({ _tag: "Queued" })
  if (!after.queued && before.queued) found.push({ _tag: "Dequeued" })
  return found
}
