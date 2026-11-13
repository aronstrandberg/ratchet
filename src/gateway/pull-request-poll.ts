import { Effect, Result } from "effect"
import * as GitHub from "./github.ts"
import * as HubReports from "./hub-reports.ts"

/** What one round of reading the watched pull requests did. */
export interface Round {
  readonly watched: number
  /** Pull requests that could not be read or reported in this round. The next round reads them again. */
  readonly failed: number
}

/**
 * Reads every pull request the hub watches, reports each observation, and asks the hub to try its undelivered
 * wake-ups again.
 *
 * One pull request that cannot be read does not stop the others from being read.
 */
export const round: Effect.Effect<Round, HubReports.HubUnavailable, GitHub.Service | HubReports.Service> = Effect.gen(
  function* () {
    const github = yield* GitHub.Service
    const hub = yield* HubReports.Service
    const refs = yield* hub.watchedPullRequests
    let failed = 0

    for (const ref of refs) {
      const reported = yield* Effect.result(Effect.flatMap(github.read(ref), hub.pullRequestFacts))

      if (Result.isFailure(reported)) {
        failed++
        yield* Effect.logWarning(`could not follow ${ref.owner}/${ref.repo}#${ref.number}`, reported.failure)
      }
    }

    yield* hub.deliverWakes

    return { watched: refs.length, failed }
  },
).pipe(Effect.withSpan("PullRequestPoll.round"))
