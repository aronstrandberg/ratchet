import { Effect, Layer, Schema } from "effect"
import type { Hub } from "../hub/entrypoint.ts"
import { ResourceRef } from "../protocol/resource.ts"
import { Binding } from "../protocol/session.ts"
import * as HubReports from "./hub-reports.ts"

const decodeBindings = Schema.decodeUnknownEffect(Schema.Array(Binding))
const decodeRefs = Schema.decodeUnknownEffect(Schema.Array(ResourceRef))

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
      resourceFacts: (observed) =>
        Effect.tryPromise({ try: () => hub.resourceFacts(observed), catch: failed("resource facts") }).pipe(
          Effect.asVoid,
        ),
      watchedResources: Effect.tryPromise(() => hub.watchedResources()).pipe(
        Effect.flatMap(decodeRefs),
        Effect.mapError(failed("watched resources")),
      ),
      deliverWakes: Effect.tryPromise({ try: () => hub.deliverWakes(), catch: failed("deliver wakes") }).pipe(
        Effect.asVoid,
      ),
    }),
  )
}
