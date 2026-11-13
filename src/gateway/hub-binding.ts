import { Effect, Layer, Schema } from "effect"
import type { Hub } from "../hub/entrypoint.ts"
import { PullRequestRef } from "../protocol/pull-request.ts"
import { Binding } from "../protocol/session.ts"
import * as HubReports from "./hub-reports.ts"

const decodeBindings = Schema.decodeUnknownEffect(Schema.Array(Binding))
const decodeRefs = Schema.decodeUnknownEffect(Schema.Array(PullRequestRef))

/** The gateway's line to the hub over the hub's service binding. */
export const layer = (hub: Service<Hub>): Layer.Layer<HubReports.Service> => {
  const failed = (operation: string) => (cause: unknown) => new HubReports.HubUnavailable({ operation, cause })

  return Layer.succeed(
    HubReports.Service,
    HubReports.Service.of({
      sessionFacts: (facts) =>
        Effect.tryPromise(() => hub.sessionFacts(facts)).pipe(
          Effect.flatMap(decodeBindings),
          Effect.mapError(failed("session facts")),
        ),
      pullRequestFacts: (facts) =>
        Effect.tryPromise({ try: () => hub.pullRequestFacts(facts), catch: failed("pull request facts") }).pipe(
          Effect.asVoid,
        ),
      watchedPullRequests: Effect.tryPromise(() => hub.watchedPullRequests()).pipe(
        Effect.flatMap(decodeRefs),
        Effect.mapError(failed("watched pull requests")),
      ),
      deliverWakes: Effect.tryPromise({ try: () => hub.deliverWakes(), catch: failed("deliver wakes") }).pipe(
        Effect.asVoid,
      ),
    }),
  )
}
