import { Option, Schema } from "effect"

/** A pull request as GitHub addresses it. */
export const PullRequestRef = Schema.Struct({
  owner: Schema.String.pipe(Schema.check(Schema.isPattern(/^[\w.-]+$/))),
  repo: Schema.String.pipe(Schema.check(Schema.isPattern(/^[\w.-]+$/))),
  number: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
})

export type PullRequestRef = typeof PullRequestRef.Type

/** The name a pull request is known by across the hub: `owner/repo#number`, lowercased. */
export const PullRequestKey = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-z0-9_.-]+\/[a-z0-9_.-]+#[1-9][0-9]*$/)),
  Schema.brand("PullRequestKey"),
)

export type PullRequestKey = typeof PullRequestKey.Type

/** The key of a pull request. Two references that differ only in letter case have the same key. */
export const keyOf = (ref: PullRequestRef): PullRequestKey =>
  PullRequestKey.make(`${ref.owner}/${ref.repo}#${ref.number}`.toLowerCase())

const parseRef = Schema.decodeUnknownOption(PullRequestRef)

/** The pull request a key names. */
export const refOf = (key: PullRequestKey): Option.Option<PullRequestRef> => {
  const [repository, number] = key.split("#")
  const [owner, repo] = (repository ?? "").split("/")

  return parseRef({ owner, repo, number: Number(number) })
}

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

/**
 * What a pull request is to a task. `owns`: the task's session drives it to mergeable. `waits_on`: the task
 * needs it merged and does not work on it. `context`: related, and nothing about it should wake anyone.
 */
export const Relation = Schema.Literals(["owns", "waits_on", "context"])

export type Relation = typeof Relation.Type

/** What a session says about its own work on a pull request. */
export const WorkStatus = Schema.Literals(["unassigned", "agent-working", "waiting-ci", "waiting-user", "blocked", "ready"])

export type WorkStatus = typeof WorkStatus.Type

/** How a pull request ended. Nothing more happens to it after that. */
export const Outcome = Schema.Literals(["merged", "closed"])

export type Outcome = typeof Outcome.Type

/**
 * What a read of a pull request answers, as it crosses from the gateway to the hub.
 *
 * A failed read is a value here, because the hub acts on which failure it was.
 */
export const ReadReply = Schema.TaggedUnion({
  Read: { facts: PullRequestFacts },
  NotFound: {},
  Unavailable: { message: Schema.String },
})

export type ReadReply = typeof ReadReply.Type
