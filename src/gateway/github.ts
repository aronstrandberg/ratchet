import { Context, Effect, Layer, Redacted, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { causeText } from "../failure.ts"
import type { Check, PullRequestFacts, PullRequestRef, Review } from "../protocol/pull-request.ts"

/** GitHub has no pull request under this reference, or the token cannot see it. */
export class PullRequestNotFound extends Schema.TaggedError<PullRequestNotFound>()("PullRequestNotFound", {
  owner: Schema.String,
  repo: Schema.String,
  number: Schema.Number,
}) {
  override get message(): string {
    return `GitHub has no pull request ${this.owner}/${this.repo}#${this.number}, or the token cannot see it`
  }
}

/** GitHub did not answer, refused the request, or answered with something this adapter cannot read. */
export class GitHubUnavailable extends Schema.TaggedError<GitHubUnavailable>()("GitHubUnavailable", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `GitHub failed (${this.operation}): ${causeText(this.cause)}`
  }
}

/** The token the gateway reads GitHub with. */
export interface Config {
  readonly token: Redacted.Redacted<string>
}

/** GitHub's pull requests, as the gateway reads them. */
export interface Interface {
  /**
   * Reads a pull request's current state in one GraphQL call, without any comment text.
   *
   * GitHub works out on demand whether a pull request merges cleanly, and the first read often says
   * `unknown`. This reads once more after two seconds when it does.
   */
  readonly read: (ref: PullRequestRef) => Effect.Effect<PullRequestFacts, PullRequestNotFound | GitHubUnavailable>
}

/** The gateway's connection to GitHub. */
export class Service extends Context.Service<Service, Interface>()("@ratchet/gateway/GitHub") {}

const query = `query($owner: String!, $repo: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      title state isDraft mergeable reviewDecision headRefOid
      mergeCommit { oid }
      mergeQueueEntry { state }
      commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) {
        pageInfo { hasNextPage }
        nodes {
          __typename
          ... on CheckRun { name status conclusion isRequired(pullRequestNumber: $number) }
          ... on StatusContext { context state isRequired(pullRequestNumber: $number) }
        }
      } } } } }
      reviewThreads(first: 100) { nodes {
        id isResolved
        first: comments(first: 1) { nodes { author { login } } }
        last: comments(last: 1) { nodes { author { login } } }
      } }
      reviews(last: 50) { nodes { id state author { login } } }
    }
  }
}`

const Author = Schema.NullOr(Schema.Struct({ login: Schema.String }))
const Comments = Schema.Struct({ nodes: Schema.Array(Schema.Struct({ author: Author })) })

const CheckContext = Schema.Struct({
  __typename: Schema.String,
  name: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  conclusion: Schema.optional(Schema.NullOr(Schema.String)),
  context: Schema.optional(Schema.String),
  state: Schema.optional(Schema.String),
  isRequired: Schema.optional(Schema.Boolean),
})

const Response = Schema.Struct({
  errors: Schema.optional(
    Schema.Array(Schema.Struct({ message: Schema.String, type: Schema.optional(Schema.String) })),
  ),
  data: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        viewer: Schema.Struct({ login: Schema.String }),
        repository: Schema.NullOr(
          Schema.Struct({
            pullRequest: Schema.NullOr(
              Schema.Struct({
                title: Schema.String,
                state: Schema.Literals(["OPEN", "MERGED", "CLOSED"]),
                isDraft: Schema.Boolean,
                mergeable: Schema.Literals(["MERGEABLE", "CONFLICTING", "UNKNOWN"]),
                reviewDecision: Schema.NullOr(Schema.Literals(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"])),
                headRefOid: Schema.String,
                mergeCommit: Schema.NullOr(Schema.Struct({ oid: Schema.String })),
                mergeQueueEntry: Schema.NullOr(Schema.Struct({ state: Schema.String })),
                commits: Schema.Struct({
                  nodes: Schema.Array(
                    Schema.Struct({
                      commit: Schema.Struct({
                        statusCheckRollup: Schema.NullOr(
                          Schema.Struct({ contexts: Schema.Struct({ nodes: Schema.Array(CheckContext) }) }),
                        ),
                      }),
                    }),
                  ),
                }),
                reviewThreads: Schema.Struct({
                  nodes: Schema.Array(
                    Schema.Struct({ id: Schema.String, isResolved: Schema.Boolean, first: Comments, last: Comments }),
                  ),
                }),
                reviews: Schema.Struct({
                  nodes: Schema.Array(Schema.Struct({ id: Schema.String, state: Schema.String, author: Author })),
                }),
              }),
            ),
          }),
        ),
      }),
    ),
  ),
})

// SAFETY: toLowerCase of a string literal is the literal that Lowercase names.
const lower = <A extends string>(value: A) => value.toLowerCase() as Lowercase<A>

const check = (context: typeof CheckContext.Type): Check => {
  const required = context.isRequired ?? false

  if (context.__typename === "CheckRun") {
    const name = context.name ?? "unnamed check"

    if (context.status !== "COMPLETED") return { name, state: "pending", required }
    const passed = ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(context.conclusion ?? "")

    return { name, state: passed ? "success" : "failure", required }
  }

  const name = context.context ?? "unnamed status"
  const state = context.state === "SUCCESS" ? "success" : context.state === "PENDING" || context.state === "EXPECTED" ? "pending" : "failure"

  return { name, state, required }
}

const reviewStates: ReadonlyArray<Review["state"]> = ["approved", "changes_requested", "commented", "dismissed", "pending"]

const login = (author: typeof Author.Type) => author?.login ?? "ghost"

/** Builds the connection on an HTTP client. Nothing is sent until a read runs. */
export const make = (config: Config): Effect.Effect<Interface, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient

    const once = Effect.fn("GitHub.read")(function* (ref: PullRequestRef) {
      yield* Effect.annotateCurrentSpan("github.pr", `${ref.owner}/${ref.repo}#${ref.number}`)

      const response = yield* HttpClientRequest.post("https://api.github.com/graphql").pipe(
        HttpClientRequest.bearerToken(Redacted.value(config.token)),
        HttpClientRequest.setHeader("user-agent", "ratchet"),
        HttpClientRequest.bodyJsonUnsafe({ query, variables: ref }),
        http.execute,
        Effect.flatMap(HttpClientResponse.schemaBodyJson(Response)),
        Effect.mapError((cause) => new GitHubUnavailable({ operation: "read", cause })),
      )

      const errors = response.errors ?? []
      const pr = response.data?.repository?.pullRequest

      if (response.data === null || response.data === undefined || pr === null || pr === undefined) {
        // GitHub answers a missing repository or pull request with an error of this type, and no data for it.
        return errors.length === 0 || errors.some((error) => error.type === "NOT_FOUND")
          ? yield* new PullRequestNotFound({ owner: ref.owner, repo: ref.repo, number: ref.number })
          : yield* new GitHubUnavailable({ operation: "read", cause: errors.map((error) => error.message).join("; ") })
      }

      const facts: PullRequestFacts = {
        ref: { owner: ref.owner, repo: ref.repo, number: ref.number },
        title: pr.title,
        state: lower(pr.state),
        draft: pr.isDraft,
        head: pr.headRefOid,
        mergeCommit: pr.mergeCommit?.oid ?? null,
        mergeable: lower(pr.mergeable),
        reviewDecision: pr.reviewDecision === null ? null : lower(pr.reviewDecision),
        queued: pr.mergeQueueEntry !== null,
        checks: (pr.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? []).map(check),
        threads: pr.reviewThreads.nodes.map((thread) => ({
          id: thread.id,
          resolved: thread.isResolved,
          author: login(thread.first.nodes[0]?.author ?? null),
          lastAuthor: login(thread.last.nodes[0]?.author ?? null),
        })),
        reviews: pr.reviews.nodes.flatMap((review) => {
          const state = reviewStates.find((known) => known === review.state.toLowerCase())

          return state === undefined ? [] : [{ id: review.id, author: login(review.author), state }]
        }),
        viewer: response.data.viewer.login,
      }

      return facts
    })

    const read = (ref: PullRequestRef) =>
      Effect.flatMap(once(ref), (facts) =>
        facts.state === "open" && facts.mergeable === "unknown"
          ? Effect.andThen(Effect.sleep("2 seconds"), once(ref))
          : Effect.succeed(facts),
      )

    return Service.of({ read })
  })

/** The connection to GitHub, still in need of an HTTP client. */
export const layerWithoutDependencies = (config: Config): Layer.Layer<Service, never, HttpClient.HttpClient> =>
  Layer.effect(Service, make(config))

/** The connection to GitHub over `fetch`. */
export const layer = (config: Config): Layer.Layer<Service> =>
  layerWithoutDependencies(config).pipe(Layer.provide(FetchHttpClient.layer))
