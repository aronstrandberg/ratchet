import { Schema } from "effect"
import { Event, Machine, State } from "effect-machine"
import { toEntity } from "effect-machine/cluster"
import { Check, PullRequestFacts, PullRequestRef, Relation, Review, Thread } from "../protocol/pull-request.ts"

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

/** A task that follows this pull request, and the session of it that attached. */
export const Subscriber = Schema.Struct({ task: Schema.String, session: Schema.String, relation: Relation })
export type Subscriber = typeof Subscriber.Type

const subscribers = { subscribers: Schema.Array(Subscriber) }

const open = {
  ref: PullRequestRef,
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
  Unseen: subscribers,
  Open: { ...open, ...subscribers },
  Merged: { ref: PullRequestRef, title: Schema.String, ...subscribers },
  Closed: { ref: PullRequestRef, title: Schema.String, ...subscribers },
})
export type PullRequestState = typeof PullRequestState.Type

export const PullRequestEvent = Event({
  Observed: { facts: PullRequestFacts },
  Attached: { subscriber: Subscriber },
  Detached: { task: Schema.String },
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

const project = (facts: PullRequestFacts, subscribers: ReadonlyArray<Subscriber>) => {
  if (facts.state === "merged") return PullRequestState.Merged({ ref: facts.ref, title: facts.title, subscribers })
  if (facts.state === "closed") return PullRequestState.Closed({ ref: facts.ref, title: facts.title, subscribers })
  return PullRequestState.Open({
    ref: facts.ref,
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
    subscribers,
  })
}

const any = [PullRequestState.Unseen, PullRequestState.Open, PullRequestState.Merged, PullRequestState.Closed] as const

/** The same state with another list of subscribers. */
const withSubscribers = (state: PullRequestState, subscribers: ReadonlyArray<Subscriber>): PullRequestState => {
  switch (state._tag) {
    case "Unseen":
      return PullRequestState.Unseen({ subscribers })
    case "Open":
      return PullRequestState.Open({ ...state, subscribers })
    case "Merged":
      return PullRequestState.Merged({ ref: state.ref, title: state.title, subscribers })
    case "Closed":
      return PullRequestState.Closed({ ref: state.ref, title: state.title, subscribers })
  }
}

export const pullRequestMachine = Machine.make({
  state: PullRequestState,
  event: PullRequestEvent,
  initial: PullRequestState.Unseen({ subscribers: [] }),
})
  .on(any, PullRequestEvent.Observed, ({ state, event }) => project(event.facts, state.subscribers))
  .on(any, PullRequestEvent.Attached, ({ state, event }) =>
    withSubscribers(state, [
      ...state.subscribers.filter((s) => s.task !== event.subscriber.task),
      event.subscriber,
    ]),
  )
  .on(any, PullRequestEvent.Detached, ({ state, event }) =>
    withSubscribers(
      state,
      state.subscribers.filter((s) => s.task !== event.task),
    ),
  )

export const PullRequestEntity = toEntity(pullRequestMachine, { type: "PullRequest" })

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

/**
 * Whether a change should wake a session of a task with this relation to the pull request.
 *
 * An owner hears what it can act on. A task that waits hears only the end. A resolved thread and a queue
 * entry need no action, so they wake nobody.
 */
export const wakes = (relation: Relation, change: Change): boolean => {
  switch (relation) {
    case "context":
      return false
    case "waits_on":
      return change._tag === "Merged" || change._tag === "Closed"
    case "owns":
      return change._tag !== "ThreadResolved" && change._tag !== "Queued" && change._tag !== "HeadMoved"
  }
}

const short = (head: string) => head.slice(0, 7)

/** One line a session can read, for one change. It holds no text written by other people. */
export const describe = (change: Change): string => {
  switch (change._tag) {
    case "HeadMoved":
      return `The head moved to ${short(change.head)}.`
    case "CiFailing":
      return `CI is failing on ${short(change.head)} while other checks still run: ${change.failed.join(", ")}.`
    case "CiFinished":
      return change.failed.length === 0
        ? `CI passed on ${short(change.head)}.`
        : `CI finished on ${short(change.head)} with failing required checks: ${change.failed.join(", ")}.`
    case "ReviewSubmitted":
      return `${change.author} submitted a review: ${change.state.replace("_", " ")}.`
    case "ThreadOpened":
      return `${change.author} opened a review thread.`
    case "ThreadResolved":
      return "A review thread was resolved."
    case "Conflicting":
      return "It has a merge conflict with its base."
    case "Queued":
      return "It entered the merge queue."
    case "Dequeued":
      return "It was removed from the merge queue without merging."
    case "Merged":
      return "It merged."
    case "Closed":
      return "It was closed without merging."
  }
}
