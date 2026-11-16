import { Schema } from "effect"

/** The infrastructure runs that carry one commit of a repository, by the commit's full hash. */
export const CommitRunsRef = Schema.Struct({
  owner: Schema.String.pipe(Schema.check(Schema.isPattern(/^[\w.-]+$/))),
  repo: Schema.String.pipe(Schema.check(Schema.isPattern(/^[\w.-]+$/))),
  commit: Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9a-f]{40}$/))),
})

export type CommitRunsRef = typeof CommitRunsRef.Type

/** One run of one stack. */
export const Run = Schema.Struct({
  id: Schema.String,
  stack: Schema.String,
  /** Spacelift's word for where the run stands, such as `PLANNING`, `UNCONFIRMED`, `APPLYING`, `FINISHED` or `FAILED`. */
  state: Schema.String,
  /** Whether a policy asks for someone's approval before the run goes on. */
  needsApproval: Schema.Boolean,
  url: Schema.String,
  /** The commit the run was started for: the followed commit itself, or a later one that includes it. */
  commit: Schema.String,
  /** When the run was created and when it last changed, in milliseconds since the epoch. */
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  /** How many resources the run's plan adds, changes and deletes, or null before it has planned. */
  delta: Schema.NullOr(Schema.Struct({ add: Schema.Int, change: Schema.Int, delete: Schema.Int })),
})

export type Run = typeof Run.Type

/**
 * The runs that carry a merge commit, as Spacelift holds them at one moment: one for each stack.
 *
 * The stacks are the ones that planned the pull request before it merged. The run that carries the commit
 * on a stack is the first tracked run that was not skipped, on the commit or on a later commit of the
 * branch. While every such run was skipped, the latest of them stands for the stack.
 *
 * The gateway reads them and makes no judgement. The hub decides what changed and whom that concerns.
 */
export const CommitRunsFacts = Schema.Struct({
  ref: CommitRunsRef,
  /** The first line of the commit's message, which for a merged pull request is its title and number. */
  title: Schema.String,
  /** One run for each stack, in the order of the stacks' names. */
  runs: Schema.Array(Run),
})

export type CommitRunsFacts = typeof CommitRunsFacts.Type
