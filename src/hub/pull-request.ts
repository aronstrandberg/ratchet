import { Effect, Equal, Schema } from "effect"
import { Event, Machine, State } from "effect-machine"
import { toEntity } from "effect-machine/cluster"
import { TaskId } from "../protocol/ids.ts"
import { Check, PullRequestFacts, PullRequestRef, Review, Thread } from "../protocol/pull-request.ts"
import type { Outcome, Relation, WorkStatus } from "../protocol/resource.ts"
import { Subscriber, attach, detach } from "./subscribers.ts"
import type { Attention } from "./attention.ts"

/**
 * Where CI stands on one head commit: `Absent` until a check reports, `Running`, `Failing` once a check has
 * failed while others still run, then `Finished`. A check that runs again, as some do when a review lands,
 * takes it back to `Running`, so the cell also holds how CI last finished on the head, and tells a session of
 * an end only when its result differs from the one it was told.
 *
 * `Absent` is not `Finished`: a repository without CI never has a check, and one with CI has none for the
 * first seconds after a push.
 */
export const Ci = Schema.TaggedUnion({
  Absent: {},
  Running: {},
  Failing: { failed: Schema.Array(Schema.String) },
  Finished: { failed: Schema.Array(Schema.String) },
})

/** Where CI stands on a head commit. */
export type Ci = typeof Ci.Type

/** The counted checks that have failed so far. */
export const failedChecks = (ci: Ci): ReadonlyArray<string> =>
  Ci.match(ci, {
    Absent: () => [],
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
  /** The checks that failed when CI last finished on this head, or null while it has not finished on it. */
  finished: Schema.NullOr(Schema.Array(Schema.String)).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
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
  if (checks.length === 0) return Ci.cases.Absent.make({})

  const required = checks.filter((check) => check.required)
  const counted = required.length > 0 ? required : checks
  const failed = counted.filter((check) => check.state === "failure").map((check) => check.name)

  if (counted.some((check) => check.state === "pending")) {
    return failed.length > 0 ? Ci.cases.Failing.make({ failed }) : Ci.cases.Running.make({})
  }

  return Ci.cases.Finished.make({ failed })
}

const project = (facts: PullRequestFacts, previous: PullRequestState) => {
  const subscribers = previous.subscribers

  if (facts.state === "merged") return PullRequestState.Merged({ ref: facts.ref, title: facts.title, subscribers })

  if (facts.state === "closed") return PullRequestState.Closed({ ref: facts.ref, title: facts.title, subscribers })

  const now = ci(facts.checks)

  return PullRequestState.Open({
    ref: facts.ref,
    title: facts.title,
    head: facts.head,
    draft: facts.draft,
    conflicting: facts.mergeable === "conflicting",
    reviewDecision: facts.reviewDecision,
    queued: facts.queued,
    ci: now,
    finished: Ci.guards.Finished(now) ? now.failed : isOpen(previous) && previous.head === facts.head ? previous.finished : null,
    threads: facts.threads,
    reviews: facts.reviews,
    viewer: facts.viewer,
    subscribers,
  })
}

/**
 * Whether an observation says nothing the cell does not hold already.
 *
 * The gateway reads a followed pull request every minute, and most reads repeat the one before. A repeat is
 * not sent to the cell, because the cell would store it.
 */
export const repeats = (state: PullRequestState, facts: PullRequestFacts): boolean =>
  Equal.equals(state, project(facts, state))

const any = [PullRequestState.Unseen, PullRequestState.Open, PullRequestState.Merged, PullRequestState.Closed] as const

/** How a pull request's state follows from what happens to it. */
export const pullRequestMachine = Machine.make({
  state: PullRequestState,
  event: PullRequestEvent,
  initial: PullRequestState.Unseen({ subscribers: [] }),
})
  .on(any, PullRequestEvent.Observed, ({ state, event }) => project(event.facts, state))
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

/**
 * Whether a pull request merged between two observations, having been open at the first.
 *
 * One that was merged already when the hub first saw it did not merge while anyone followed it.
 */
export const mergedWhileFollowed = (before: PullRequestState, after: PullRequestState): boolean =>
  isOpen(before) && isMerged(after)

type Open = typeof PullRequestState.variants.Open.Type

const isOpen = PullRequestState.$is("Open")
const isMerged = PullRequestState.$is("Merged")
const isClosed = PullRequestState.$is("Closed")

/** Whether CI ended with the same failed checks as when the session was last told of an end. */
const sameChecks = (told: ReadonlyArray<string> | null, failed: ReadonlyArray<string>) =>
  told !== null && told.length === failed.length && told.every((name) => failed.includes(name))

const changesWhileOpen = (before: Open, after: Open): ReadonlyArray<Change> => {
  const found: Array<Change> = []
  const sameHead = before.head === after.head

  if (!sameHead) found.push(Change.cases.HeadMoved.make({ head: after.head }))

  // A new head starts CI over, whatever the old head's CI said.
  const ciBefore = sameHead ? before.ci : Ci.cases.Absent.make({})
  const told = sameHead ? before.finished : null

  // A failure while checks still run is told before CI first ends on the head, not when a check runs again.
  if (told === null && Ci.guards.Failing(after.ci) && (Ci.guards.Running(ciBefore) || Ci.guards.Absent(ciBefore))) {
    found.push(Change.cases.CiFailing.make({ head: after.head, failed: after.ci.failed }))
  }

  if (Ci.guards.Finished(after.ci) && !Ci.guards.Finished(ciBefore) && !sameChecks(told, after.ci.failed)) {
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
 * What a change asks of a session of a task with this relation to the pull request, or null for nothing.
 *
 * A task that waits hears only the end. An owner acts on a failure, a conflict, a review with comments or a
 * request for changes, a new review thread and an unexpected end: a code review is what a session waits for
 * before it queues, and a thread is a finding to answer, whoever wrote them. A merge acts too: the merge queue
 * merges, often long after the session queued it, and the session follows up. Passed checks and approvals may
 * already be known to the session, which often caused them, so they are screened. Passed checks act unless the
 * session said it is at work on the pull request.
 */
export const attention = (relation: Relation, change: Change, status: WorkStatus): Attention | null => {
  switch (relation) {
    case "context":
      return null
    case "waits_on":
      return isEnd(change) ? "act" : null
    case "owns":
      return Change.match(change, {
        HeadMoved: () => null,
        CiFailing: () => "act" as const,
        // A session that waits merges, queues or asks for a review once CI passes. One at work has usually
        // pushed again, so the pass may be of a head it no longer cares about.
        CiFinished: ({ failed }) =>
          failed.length > 0 || status !== "agent-working" ? ("act" as const) : ("screen" as const),
        ReviewSubmitted: ({ state }) =>
          state === "changes_requested" || state === "commented" ? ("act" as const) : ("screen" as const),
        ThreadOpened: () => "act" as const,
        ThreadResolved: () => "note" as const,
        Conflicting: () => "act" as const,
        Queued: () => "note" as const,
        Dequeued: () => "act" as const,
        Merged: () => "act" as const,
        Closed: () => "act" as const,
      })
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
