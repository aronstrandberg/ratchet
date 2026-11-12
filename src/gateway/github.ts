import { Effect, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import type { Check, PullRequestFacts, PullRequestRef, Review } from "../protocol/pull-request.ts"

export class GitHubError extends Schema.TaggedError<GitHubError>()("GitHubError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

const query = `query($owner: String!, $repo: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      title state isDraft mergeable reviewDecision headRefOid
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

const Context = Schema.Struct({
  __typename: Schema.String,
  name: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  conclusion: Schema.optional(Schema.NullOr(Schema.String)),
  context: Schema.optional(Schema.String),
  state: Schema.optional(Schema.String),
  isRequired: Schema.optional(Schema.Boolean),
})

const Response = Schema.Struct({
  errors: Schema.optional(Schema.Array(Schema.Struct({ message: Schema.String }))),
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
                mergeQueueEntry: Schema.NullOr(Schema.Struct({ state: Schema.String })),
                commits: Schema.Struct({
                  nodes: Schema.Array(
                    Schema.Struct({
                      commit: Schema.Struct({
                        statusCheckRollup: Schema.NullOr(
                          Schema.Struct({ contexts: Schema.Struct({ nodes: Schema.Array(Context) }) }),
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

const lower = <A extends string>(value: A) => value.toLowerCase() as Lowercase<A>

const check = (context: typeof Context.Type): Check => {
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

/** Reads a pull request's current state from GitHub in one GraphQL call. */
export const read = (token: string, ref: PullRequestRef): Effect.Effect<PullRequestFacts, GitHubError> =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const response = yield* HttpClientRequest.post("https://api.github.com/graphql").pipe(
      HttpClientRequest.bearerToken(token),
      HttpClientRequest.setHeader("user-agent", "ratchet"),
      HttpClientRequest.bodyJsonUnsafe({ query, variables: ref }),
      http.execute,
      Effect.flatMap(HttpClientResponse.schemaBodyJson(Response)),
    )
    const pr = response.data?.repository?.pullRequest
    if (pr === null || pr === undefined || response.data === null || response.data === undefined) {
      const message = response.errors?.map((error) => error.message).join("; ") ?? "pull request not found"
      return yield* new GitHubError({ operation: "read", message })
    }
    const login = (author: typeof Author.Type) => author?.login ?? "ghost"
    return {
      ref,
      title: pr.title,
      state: lower(pr.state),
      draft: pr.isDraft,
      head: pr.headRefOid,
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
  }).pipe(
    Effect.mapError((cause) => (cause instanceof GitHubError ? cause : new GitHubError({ operation: "read", message: String(cause) }))),
    Effect.provide(FetchHttpClient.layer),
    Effect.withSpan("GitHub.read", { attributes: { "github.pr": `${ref.owner}/${ref.repo}#${ref.number}` } }),
  )
