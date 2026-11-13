import { Context, Effect, Layer, Redacted, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { causeText } from "../failure.ts"
import type { LinearIssueFacts, LinearIssueRef } from "../protocol/linear.ts"
import { NotConfigured } from "./not-configured.ts"

/** Linear has no issue under this identifier, or the key cannot see it. */
export class IssueNotFound extends Schema.TaggedError<IssueNotFound>()("IssueNotFound", {
  identifier: Schema.String,
}) {
  override get message(): string {
    return `Linear has no issue ${this.identifier}, or the key cannot see it`
  }
}

/** Linear did not answer, refused the request, or answered with something this adapter cannot read. */
export class LinearUnavailable extends Schema.TaggedError<LinearUnavailable>()("LinearUnavailable", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Linear failed (${this.operation}): ${causeText(this.cause)}`
  }
}

/** Where Linear's GraphQL API is, and the personal API key the gateway reads it with. */
export interface Config {
  readonly url: string
  readonly key: Redacted.Redacted<string>
}

/** Linear's issues, as the gateway reads them. */
export interface Interface {
  /** Reads an issue's current state in one GraphQL call, without its description or any comment text. */
  readonly read: (
    ref: LinearIssueRef,
  ) => Effect.Effect<LinearIssueFacts, IssueNotFound | LinearUnavailable | NotConfigured>
}

/** The gateway's connection to Linear. */
export class Service extends Context.Service<Service, Interface>()("@ratchet/gateway/Linear") {}

const query = `query($id: String!) {
  viewer { id displayName }
  issue(id: $id) {
    identifier title url
    state { name type }
    assignee { id displayName }
    comments(last: 30) { nodes { id user { displayName } botActor { name } } }
  }
}`

const Person = Schema.Struct({ id: Schema.String, displayName: Schema.String })

const Response = Schema.Struct({
  errors: Schema.optional(
    Schema.Array(
      Schema.Struct({
        message: Schema.String,
        extensions: Schema.optional(Schema.Struct({ code: Schema.optional(Schema.String) })),
      }),
    ),
  ),
  data: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        viewer: Schema.optional(Schema.NullOr(Person)),
        issue: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              identifier: Schema.String,
              title: Schema.String,
              url: Schema.String,
              state: Schema.Struct({ name: Schema.String, type: Schema.String }),
              assignee: Schema.NullOr(Person),
              comments: Schema.Struct({
                nodes: Schema.Array(
                  Schema.Struct({
                    id: Schema.String,
                    user: Schema.optional(Schema.NullOr(Schema.Struct({ displayName: Schema.String }))),
                    botActor: Schema.optional(Schema.NullOr(Schema.Struct({ name: Schema.NullOr(Schema.String) }))),
                  }),
                ),
              }),
            }),
          ),
        ),
      }),
    ),
  ),
})

/** Builds the connection on an HTTP client. Nothing is sent until a read runs. */
export const make = (config: Config): Effect.Effect<Interface, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient

    const read = Effect.fn("Linear.read")(function* (ref: LinearIssueRef) {
      yield* Effect.annotateCurrentSpan("linear.issue", ref.identifier)

      // Linear answers a query it rejects with status 400 and a body that says why, so the body is read
      // whatever the status.
      const response = yield* HttpClientRequest.post(config.url).pipe(
        // A personal API key goes in the header as it is, without a scheme in front.
        HttpClientRequest.setHeader("authorization", Redacted.value(config.key)),
        HttpClientRequest.bodyJsonUnsafe({ query, variables: { id: ref.identifier } }),
        http.execute,
        Effect.flatMap(HttpClientResponse.schemaBodyJson(Response)),
        Effect.mapError((cause) => new LinearUnavailable({ operation: "read", cause })),
      )

      const errors = response.errors ?? []
      const issue = response.data?.issue
      const viewer = response.data?.viewer

      if (issue === null || issue === undefined) {
        // Linear answers a missing issue with an error whose message says the entity was not found.
        const missing = errors.length === 0 || errors.some((error) => /not found/i.test(error.message))

        return missing
          ? yield* new IssueNotFound({ identifier: ref.identifier })
          : yield* new LinearUnavailable({ operation: "read", cause: errors.map((error) => error.message).join("; ") })
      }

      if (viewer === null || viewer === undefined) {
        return yield* new LinearUnavailable({ operation: "read", cause: "the answer does not say whose key this is" })
      }

      const facts: LinearIssueFacts = {
        ref: { identifier: ref.identifier },
        title: issue.title,
        url: issue.url,
        state: issue.state,
        assignee: issue.assignee === null ? null : { id: issue.assignee.id, name: issue.assignee.displayName },
        comments: issue.comments.nodes.map((comment) => ({
          id: comment.id,
          author: comment.user?.displayName ?? comment.botActor?.name ?? "an integration",
        })),
        viewer: { id: viewer.id, name: viewer.displayName },
      }

      return facts
    })

    return Service.of({ read })
  })

/** The connection to Linear, still in need of an HTTP client. */
export const layerWithoutDependencies = (config: Config): Layer.Layer<Service, never, HttpClient.HttpClient> =>
  Layer.effect(Service, make(config))

/** The connection to Linear over `fetch`. */
export const layer = (config: Config): Layer.Layer<Service> =>
  layerWithoutDependencies(config).pipe(Layer.provide(FetchHttpClient.layer))

/** A connection that fails every read, for a gateway that was given no key for Linear. */
export const layerNotConfigured: Layer.Layer<Service> = Layer.succeed(
  Service,
  Service.of({
    read: () => Effect.fail(new NotConfigured({ setting: "LINEAR_API_KEY" })),
  }),
)
