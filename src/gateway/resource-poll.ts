import { Effect } from "effect"
import { ReadReply, labelOf } from "../protocol/resource.ts"
import type * as GitHub from "./github.ts"
import * as HubReports from "./hub-reports.ts"
import type * as IncidentIo from "./incident-io.ts"
import type * as Linear from "./linear.ts"
import * as ResourceReads from "./resource-reads.ts"

/** What one round of reading the watched resources did. */
export interface Round {
  readonly watched: number
  /** Resources that could not be read or reported in this round. The next round reads them again. */
  readonly failed: number
}

/**
 * Reads every resource the hub watches, reports each observation, and asks the hub to try its undelivered
 * wake-ups again.
 *
 * One resource that cannot be read does not stop the others from being read.
 */
export const round: Effect.Effect<
  Round,
  HubReports.HubUnavailable,
  GitHub.Service | Linear.Service | IncidentIo.Service | HubReports.Service
> = Effect.gen(function* () {
  const hub = yield* HubReports.Service
  const refs = yield* hub.watchedResources
  let failed = 0

  for (const ref of refs) {
    const problem = yield* Effect.flatMap(
      ResourceReads.read(ref),
      ReadReply.match({
        Read: ({ observed }) =>
          hub.resourceFacts(observed).pipe(
            Effect.as(null),
            Effect.catch((failure) => Effect.succeed(failure.message)),
          ),
        NotFound: () => Effect.succeed("it is gone, or the gateway cannot see it any more"),
        NotConfigured: ({ setting }) => Effect.succeed(`${setting} is not set`),
        Unavailable: ({ message }) => Effect.succeed(message),
      }),
    )

    if (problem !== null) {
      failed++
      yield* Effect.logWarning(`could not follow ${labelOf(ref)}: ${problem}`)
    }
  }

  yield* hub.deliverWakes

  return { watched: refs.length, failed }
}).pipe(Effect.withSpan("ResourcePoll.round"))
