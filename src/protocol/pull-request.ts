import { Schema } from "effect"

/** A pull request as GitHub addresses it. */
export const PullRequestRef = Schema.Struct({
  owner: Schema.String.pipe(Schema.check(Schema.isPattern(/^[\w.-]+$/))),
  repo: Schema.String.pipe(Schema.check(Schema.isPattern(/^[\w.-]+$/))),
  number: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
})

export type PullRequestRef = typeof PullRequestRef.Type

/** One check on a pull request's head commit: a check run or a commit status. */
export const Check = Schema.Struct({
  name: Schema.String,
  state: Schema.Literals(["pending", "success", "failure"]),
  /** Whether the base branch requires this check before a merge. */
  required: Schema.Boolean,
})

export type Check = typeof Check.Type

/** A review thread on a pull request, without its text. */
export const Thread = Schema.Struct({
  id: Schema.String,
  resolved: Schema.Boolean,
  /** Login of who opened the thread. */
  author: Schema.String,
  /** Login of who wrote its latest comment. */
  lastAuthor: Schema.String,
})

export type Thread = typeof Thread.Type

/** A review someone submitted on a pull request, without its text. */
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
