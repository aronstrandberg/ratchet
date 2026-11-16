import { Schema } from "effect"

/** The CI builds that carry one commit of a repository, by the commit's full hash. */
export const CommitBuildsRef = Schema.Struct({
  owner: Schema.String.pipe(Schema.check(Schema.isPattern(/^[\w.-]+$/))),
  repo: Schema.String.pipe(Schema.check(Schema.isPattern(/^[\w.-]+$/))),
  commit: Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9a-f]{40}$/))),
})

export type CommitBuildsRef = typeof CommitBuildsRef.Type

/** One build in one pipeline. */
export const Build = Schema.Struct({
  id: Schema.String,
  pipeline: Schema.String,
  number: Schema.Int,
  /** The CI system's word for where the build stands, such as `running`, `failing`, `failed` or `passed`. */
  state: Schema.String,
  url: Schema.String,
  /** The commit the build built: the followed commit itself, or a later one that includes it. */
  commit: Schema.String,
  /** When the build was created, in milliseconds since the epoch. */
  createdAt: Schema.Number,
  /** The jobs that failed, each by its step's key or else its name. Empty for a build that has not failed. */
  failedJobs: Schema.Array(Schema.String),
})

export type Build = typeof Build.Type

/**
 * The builds that carry a commit, as the CI system holds them at one moment: one for each pipeline.
 *
 * A branch gets several commits in one push, and a pipeline skips a build when a newer one is waiting. So the
 * build that carries a commit in a pipeline is the first one that ran on the commit or on a later commit of
 * the branch. While every build of a pipeline since the commit was skipped or canceled, the latest of those
 * stands for the pipeline. The pipelines are the ones that the push which brought the commit onto its branch
 * started. A build on a schedule is not among them.
 *
 * The gateway reads them and makes no judgement. The hub decides what changed and whom that concerns.
 */
export const CommitBuildsFacts = Schema.Struct({
  ref: CommitBuildsRef,
  /** The first line of the commit's message, which for a merged pull request is its title and number. */
  title: Schema.String,
  /** One build for each pipeline, in the order of the pipelines' names. */
  builds: Schema.Array(Build),
})

export type CommitBuildsFacts = typeof CommitBuildsFacts.Type
