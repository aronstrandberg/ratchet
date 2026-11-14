import { Effect } from "effect"
import { ReadReply, ResourceFacts, ResourceRef } from "../protocol/resource.ts"
import * as GitHub from "./github.ts"
import * as IncidentIo from "./incident-io.ts"
import * as Linear from "./linear.ts"

const Reply = ReadReply.cases
const Observed = ResourceFacts.cases

const notFound = () => Effect.succeed(Reply.NotFound.make({}))
const notSignedIn = ({ system }: { readonly system: string }) => Effect.succeed(Reply.NotSignedIn.make({ system }))
const unavailable = (failure: { readonly message: string }) => Effect.succeed(Reply.Unavailable.make({ message: failure.message }))

/**
 * Reads a resource from its own system: a pull request from GitHub, an issue from Linear, an incident from
 * incident.io.
 *
 * A resource that is missing or cannot be read is an answer, not a failure, because the hub acts on which it
 * was. So is a system the gateway is not signed in to.
 */
export const read = (
  ref: ResourceRef,
): Effect.Effect<ReadReply, never, GitHub.Service | Linear.Service | IncidentIo.Service> =>
  ResourceRef.match(ref, {
    PullRequest: (pullRequest) =>
      Effect.flatMap(GitHub.Service, (github) => github.read(pullRequest)).pipe(
        Effect.map((facts) => Reply.Read.make({ observed: Observed.PullRequest.make({ facts }) })),
        Effect.catchTags({ PullRequestNotFound: notFound, GitHubUnavailable: unavailable }),
      ),
    LinearIssue: (issue) =>
      Effect.flatMap(Linear.Service, (linear) => linear.read(issue)).pipe(
        Effect.map((facts) => Reply.Read.make({ observed: Observed.LinearIssue.make({ facts }) })),
        Effect.catchTags({ IssueNotFound: notFound, LinearUnavailable: unavailable, NotSignedIn: notSignedIn }),
      ),
    Incident: (incident) =>
      Effect.flatMap(IncidentIo.Service, (incidents) => incidents.read(incident)).pipe(
        Effect.map((facts) => Reply.Read.make({ observed: Observed.Incident.make({ facts }) })),
        Effect.catchTags({
          IncidentNotFound: notFound,
          IncidentIoUnavailable: unavailable,
          NotSignedIn: notSignedIn,
        }),
      ),
  })
