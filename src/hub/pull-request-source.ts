import { Context, type Effect, Schema } from "effect"
import { type PullRequestFacts, PullRequestKey, type PullRequestRef } from "../protocol/pull-request.ts"

/** GitHub has no pull request under this reference, or the gateway's token cannot see it. */
export class PullRequestNotFound extends Schema.TaggedError<PullRequestNotFound>()("PullRequestNotFound", {
  pullRequest: PullRequestKey,
}) {}

/** A pull request could not be read now. Reading it again later may work. */
export class PullRequestUnreadable extends Schema.TaggedError<PullRequestUnreadable>()("PullRequestUnreadable", {
  pullRequest: PullRequestKey,
  cause: Schema.Defect(),
}) {}

/** Where the hub reads a pull request's current state. The gateway reads it from GitHub. */
export interface Interface {
  /** Reads a pull request now. The gateway keeps reading a pull request the hub watches. */
  readonly read: (
    ref: PullRequestRef,
  ) => Effect.Effect<PullRequestFacts, PullRequestNotFound | PullRequestUnreadable>
}

/** The hub's source of pull request observations. */
export class Service extends Context.Service<Service, Interface>()("@ratchet/hub/PullRequestSource") {}
