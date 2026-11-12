import { Schema } from "effect"

export const PullRequestRef = Schema.Struct({
  owner: Schema.String,
  repo: Schema.String,
  number: Schema.Int,
})

export type PullRequestRef = typeof PullRequestRef.Type

export const Check = Schema.Struct({
  name: Schema.String,
  state: Schema.Literals(["pending", "success", "failure"]),
  /** Whether the base branch requires this check before a merge. */
  required: Schema.Boolean,
})

export type Check = typeof Check.Type

export const Thread = Schema.Struct({
  id: Schema.String,
  resolved: Schema.Boolean,
  /** Login of who opened the thread. */
  author: Schema.String,
  /** Login of who wrote its latest comment. */
  lastAuthor: Schema.String,
})

export type Thread = typeof Thread.Type

export const Review = Schema.Struct({
  id: Schema.String,
  author: Schema.String,
  state: Schema.Literals(["approved", "changes_requested", "commented", "dismissed", "pending"]),
})

export type Review = typeof Review.Type

/**
 * A pull request as GitHub holds it at one moment, without any comment text.
 *
 * The gateway reads it and makes no judgement. The hub decides what changed and whom that concerns.
 */
export const PullRequestFacts = Schema.Struct({
  ref: PullRequestRef,
  title: Schema.String,
  state: Schema.Literals(["open", "merged", "closed"]),
  draft: Schema.Boolean,
  /** The head commit. */
  head: Schema.String,
  mergeable: Schema.Literals(["mergeable", "conflicting", "unknown"]),
  reviewDecision: Schema.NullOr(Schema.Literals(["approved", "changes_requested", "review_required"])),
  queued: Schema.Boolean,
  checks: Schema.Array(Check),
  threads: Schema.Array(Thread),
  reviews: Schema.Array(Review),
  /** Login the gateway's token belongs to, to tell my own activity from other people's. */
  viewer: Schema.String,
})

export type PullRequestFacts = typeof PullRequestFacts.Type

/** The key a pull request is known by across the hub: `owner/repo#number`, lowercased. */
export const pullRequestKey = (ref: PullRequestRef) => `${ref.owner}/${ref.repo}#${ref.number}`.toLowerCase()

/**
 * What a pull request is to a task. `owns`: the task's session drives it to mergeable. `waits_on`: the task
 * needs it merged and does not work on it. `context`: related, and nothing about it should wake anyone.
 */
export const Relation = Schema.Literals(["owns", "waits_on", "context"])

export type Relation = typeof Relation.Type

/** What a session says about its own work on a pull request. */
export const WorkStatus = Schema.Literals(["unassigned", "agent-working", "waiting-ci", "waiting-user", "blocked", "ready"])

export type WorkStatus = typeof WorkStatus.Type
