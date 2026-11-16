import { Effect } from "effect"
import { ReadReply, type ResourceRef, keyOf, labelOf } from "../protocol/resource.ts"
import type * as CommitBuilds from "./commit-builds.ts"
import type * as CommitRuns from "./commit-runs.ts"
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

/** What reading a resource needs: the gateway's connection to each system, and its line to the hub. */
export type Readers =
  | GitHub.Service
  | Linear.Service
  | IncidentIo.Service
  | CommitBuilds.Service
  | CommitRuns.Service
  | HubReports.Service

/**
 * Reads one resource from its own system and reports the observation to the hub.
 *
 * It answers whether that worked. A resource that cannot be read or reported is logged, and whoever asked
 * reads it again later.
 */
export const follow = (ref: ResourceRef): Effect.Effect<boolean, never, Readers> =>
  Effect.gen(function* () {
    const hub = yield* HubReports.Service

    const problem = yield* Effect.flatMap(
      ResourceReads.read(ref),
      ReadReply.match({
        Read: ({ observed }) =>
          hub.resourceFacts(observed).pipe(
            Effect.as(null),
            Effect.catch((failure) => Effect.succeed(failure.message)),
          ),
        NotFound: () => Effect.succeed("it is gone, or the gateway cannot see it any more"),
        NotSignedIn: ({ system }) => Effect.succeed(`Ratchet is not signed in to ${system}`),
        Unavailable: ({ message }) => Effect.succeed(message),
      }),
    )

    if (problem !== null) yield* Effect.logWarning(`could not follow ${labelOf(ref)}: ${problem}`)

    return problem === null
  })

/**
 * Reads every resource the hub watches, reports each observation, and asks the hub to try its undelivered
 * wake-ups again.
 *
 * A resource whose key is in `heard` is left out: the webhook proxy tells the gateway when it changes, and
 * the gateway reads it then. One resource that cannot be read does not stop the others from being read.
 */
export const round = (heard: ReadonlySet<string>): Effect.Effect<Round, HubReports.HubUnavailable, Readers> =>
  Effect.gen(function* () {
    const hub = yield* HubReports.Service
    const refs = (yield* hub.watchedResources).filter((ref) => !heard.has(keyOf(ref)))
    let failed = 0

    for (const ref of refs) {
      if (!(yield* follow(ref))) failed++
    }

    yield* hub.deliverWakes

    return { watched: refs.length, failed }
  }).pipe(Effect.withSpan("ResourcePoll.round"))
