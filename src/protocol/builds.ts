import { Schema } from "effect"

/** The CI builds of one commit, by the commit's full hash. */
export const CommitBuildsRef = Schema.Struct({
  commit: Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9a-f]{40}$/))),
})

export type CommitBuildsRef = typeof CommitBuildsRef.Type

/** One build of a commit in one pipeline. */
export const Build = Schema.Struct({
  id: Schema.String,
  pipeline: Schema.String,
  number: Schema.Int,
  /** The CI system's word for where the build stands, such as `running`, `failing`, `failed` or `passed`. */
  state: Schema.String,
  url: Schema.String,
  /** When the build was created, in milliseconds since the epoch. */
  createdAt: Schema.Number,
  /** The jobs that failed, each by its step's key or else its name. Empty for a build that has not failed. */
  failedJobs: Schema.Array(Schema.String),
})

export type Build = typeof Build.Type

/**
 * The builds of a commit as the CI system holds them at one moment.
 *
 * They are the builds that the commit's arrival on its branch started, and the builds those started. A build
 * on a schedule and a build the merge queue ran before the merge are not among them. The gateway reads them
 * and makes no judgement. The hub decides what changed and whom that concerns.
 */
export const CommitBuildsFacts = Schema.Struct({
  ref: CommitBuildsRef,
  /** The first line of the commit's message, which for a merged pull request is its title and number. */
  title: Schema.String,
  builds: Schema.Array(Build),
})

export type CommitBuildsFacts = typeof CommitBuildsFacts.Type
