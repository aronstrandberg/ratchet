import { Schema } from "effect"
import { Event, Machine, State } from "effect-machine"
import { toEntity } from "effect-machine/cluster"
import { TaskId } from "../protocol/ids.ts"
import { Check, PullRequestFacts, PullRequestRef, Review, Thread } from "../protocol/pull-request.ts"
import type { Outcome, Relation } from "../protocol/resource.ts"
import { Subscriber, attach, detach } from "./subscribers.ts"

/**
 * Where CI stands on one head commit. It moves forward only: `Running`, then `Failing` once a check has failed
 * while others still run, then `Finished`. So a head produces at most two CI changes: the first failure and the end.
 */
export const Ci = Schema.TaggedUnion({
  Running: {},
  Failing: { failed: Schema.Array(Schema.String) },
  Finished: { failed: Schema.Array(Schema.String) },
})

/** Where CI stands on a head commit. */
export type Ci = typeof Ci.Type

/** The counted checks that have failed so far. */
export const failedChecks = (ci: Ci): ReadonlyArray<string> =>
  Ci.match(ci, {
    Running: () => [],
    Failing: ({ failed }) => failed,
    Finished: ({ failed }) => failed,
  })

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

/** What the hub holds about a pull request: what GitHub last said, and who follows it. */
export const PullRequestState = State({
  Unseen: subscribers,
  Open: { ...open, ...subscribers },
  Merged: { ref: PullRequestRef, title: Schema.String, ...subscribers },
  Closed: { ref: PullRequestRef, title: Schema.String, ...subscribers },
})

/** A pull request's state, in any of its tags. */
export type PullRequestState = typeof PullRequestState.Type

/** What can happen to a pull request as the hub sees it. */
export const PullRequestEvent = Event({
  Observed: { facts: PullRequestFacts },
  Attached: { subscriber: Subscriber },
  Detached: { task: TaskId },
})

/** CI counts the checks the base branch requires, or every check when it requires none. */
const ci = (checks: ReadonlyArray<Check>): Ci => {
  const required = checks.filter((check) => check.required)
  const counted = required.length > 0 ? required : checks
  const failed = counted.filter((check) => check.state === "failure").map((check) => check.name)

  if (counted.some((check) => check.state === "pending")) {
    return failed.length > 0 ? Ci.cases.Failing.make({ failed }) : Ci.cases.Running.make({})
  }

  return Ci.cases.Finished.make({ failed })
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

/** How a pull request's state follows from what happens to it. */
export const pullRequestMachine = Machine.make({
  state: PullRequestState,
  event: PullRequestEvent,
  initial: PullRequestState.Unseen({ subscribers: [] }),
})
  .on(any, PullRequestEvent.Observed, ({ state, event }) => project(event.facts, state.subscribers))
  .on(any, PullRequestEvent.Attached, ({ state, event }) =>
    PullRequestState.with(state, { subscribers: attach(state.subscribers, event.subscriber) }),
  )
  .on(any, PullRequestEvent.Detached, ({ state, event }) =>
    PullRequestState.with(state, { subscribers: detach(state.subscribers, event.task) }),
  )

/** A pull request as a cell: one per pull request key. */
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

/** One thing that happened to a pull request. */
export type Change = typeof Change.Type

/**
 * What changed between two observations of a pull request.
 *
 * The first observation of an open pull request reports nothing: a task that attaches reads the state itself.
 * My own reviews and threads are not changes, because my sessions post under my login.
 */
export const changes = (before: PullRequestState, after: PullRequestState): ReadonlyArray<Change> =>
  PullRequestState.$match<ReadonlyArray<Change>>(after, {
    Unseen: () => [],
    Merged: () => (isMerged(before) ? [] : [Change.cases.Merged.make({})]),
    Closed: () => (isClosed(before) ? [] : [Change.cases.Closed.make({})]),
    Open: (open) => (isOpen(before) ? changesWhileOpen(before, open) : []),
  })

type Open = typeof PullRequestState.variants.Open.Type

const isOpen = PullRequestState.$is("Open")
const isMerged = PullRequestState.$is("Merged")
const isClosed = PullRequestState.$is("Closed")

const changesWhileOpen = (before: Open, after: Open): ReadonlyArray<Change> => {
  const found: Array<Change> = []
  const sameHead = before.head === after.head

  if (!sameHead) found.push(Change.cases.HeadMoved.make({ head: after.head }))

  // A new head starts CI over, whatever the old head's CI said.
  const ciBefore = sameHead ? before.ci : Ci.cases.Running.make({})

  if (Ci.guards.Failing(after.ci) && Ci.guards.Running(ciBefore)) {
    found.push(Change.cases.CiFailing.make({ head: after.head, failed: after.ci.failed }))
  }

  if (Ci.guards.Finished(after.ci) && !Ci.guards.Finished(ciBefore)) {
    found.push(Change.cases.CiFinished.make({ head: after.head, failed: after.ci.failed }))
  }

  const seenReviews = new Set(before.reviews.map((review) => review.id))

  for (const review of after.reviews) {
    if (!seenReviews.has(review.id) && review.state !== "pending" && review.author !== after.viewer) {
      found.push(Change.cases.ReviewSubmitted.make({ author: review.author, state: review.state }))
    }
  }

  const threadsBefore = new Map(before.threads.map((thread) => [thread.id, thread]))

  for (const thread of after.threads) {
    const known = threadsBefore.get(thread.id)

    if (known === undefined && !thread.resolved && thread.author !== after.viewer) {
      found.push(Change.cases.ThreadOpened.make({ thread: thread.id, author: thread.author }))
    }

    if (known !== undefined && !known.resolved && thread.resolved) {
      found.push(Change.cases.ThreadResolved.make({ thread: thread.id }))
    }
  }

  if (after.conflicting && !before.conflicting) found.push(Change.cases.Conflicting.make({}))

  if (after.queued && !before.queued) found.push(Change.cases.Queued.make({}))

  if (!after.queued && before.queued) found.push(Change.cases.Dequeued.make({}))

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
      return isEnd(change)
    case "owns":
      return !needsNoAction(change)
  }
}

const isEnd = Change.isAnyOf(["Merged", "Closed"])

/** How a pull request ended, or null while it can still change. */
export const outcomeOf = (state: PullRequestState): Outcome | null =>
  PullRequestState.$match<Outcome | null>(state, {
    Unseen: () => null,
    Open: () => null,
    Merged: () => "merged",
    Closed: () => "closed",
  })

const needsNoAction = Change.isAnyOf(["ThreadResolved", "Queued", "HeadMoved"])

const short = (head: string) => head.slice(0, 7)

/** One line a session can read, for one change. It holds no text written by other people. */
export const describe = (change: Change): string =>
  Change.match(change, {
    HeadMoved: ({ head }) => `The head moved to ${short(head)}.`,
    CiFailing: ({ head, failed }) =>
      `CI is failing on ${short(head)} while other checks still run: ${failed.join(", ")}.`,
    CiFinished: ({ head, failed }) =>
      failed.length === 0
        ? `CI passed on ${short(head)}.`
        : `CI finished on ${short(head)} with failing required checks: ${failed.join(", ")}.`,
    ReviewSubmitted: ({ author, state }) => `${author} submitted a review: ${state.replace("_", " ")}.`,
    ThreadOpened: ({ author }) => `${author} opened a review thread.`,
    ThreadResolved: () => "A review thread was resolved.",
    Conflicting: () => "It has a merge conflict with its base.",
    Queued: () => "It entered the merge queue.",
    Dequeued: () => "It was removed from the merge queue without merging.",
    Merged: () => "It merged.",
    Closed: () => "It was closed without merging.",
  })
