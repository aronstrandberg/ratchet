import { Context, Effect, Layer, Option, Ref, Schema } from "effect"
import { FetchHttpClient, type HttpClient } from "effect/http"
import { causeText } from "../failure.ts"
import type { LinearIssueFacts, LinearIssueRef } from "../protocol/linear.ts"
import * as McpClient from "./mcp-client.ts"
import type * as SignIns from "./sign-ins.ts"

/** Linear has no issue under this identifier, or my account cannot see it. */
export class IssueNotFound extends Schema.TaggedError<IssueNotFound>()("IssueNotFound", {
  identifier: Schema.String,
}) {
  override get message(): string {
    return `Linear has no issue ${this.identifier}, or my account cannot see it`
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

/** Where Linear's MCP server is. */
export interface Config {
  readonly url: string
}

/** Linear's issues, as the gateway reads them. */
export interface Interface {
  /** Reads an issue's current state, without its description or any comment text. */
  readonly read: (
    ref: LinearIssueRef,
  ) => Effect.Effect<LinearIssueFacts, IssueNotFound | LinearUnavailable | SignIns.NotSignedIn>
}

/** The gateway's connection to Linear. */
export class Service extends Context.Service<Service, Interface>()("@ratchet/gateway/Linear") {}

/** What `get_issue` answers for the fields this adapter asks for. */
const Issue = Schema.Struct({
  title: Schema.String,
  url: Schema.String,
  status: Schema.String,
  statusType: Schema.String,
  assignee: Schema.NullOr(Schema.String),
  assigneeId: Schema.NullOr(Schema.String),
})

/** What `list_comments` answers, without the text of any comment. */
const Comments = Schema.Struct({
  comments: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      /** Absent on a comment an integration wrote. */
      author: Schema.optional(Schema.NullOr(Schema.Struct({ name: Schema.String }))),
    }),
  ),
})

const User = Schema.Struct({ id: Schema.String, name: Schema.String })

/** How Linear's tools say that they have no such issue. */
const missing = /could not find|not found/i

/** Builds the connection on Linear's MCP server. Nothing is sent until a read runs. */
export const make = (config: Config): Effect.Effect<Interface, never, HttpClient.HttpClient | SignIns.Service> =>
  Effect.gen(function* () {
    const linear = yield* McpClient.make({ url: config.url, system: "linear" })
    const viewer = yield* Ref.make(Option.none<typeof User.Type>())

    /** The Linear user the sign-in belongs to. It is asked for once. */
    const me = Effect.gen(function* () {
      const known = yield* Ref.get(viewer)

      if (Option.isSome(known)) return known.value

      const user = yield* linear.call("get_user", { query: "me" }, User)
      yield* Ref.set(viewer, Option.some(user))

      return user
    })

    const read = Effect.fn("Linear.read")(function* (ref: LinearIssueRef) {
      yield* Effect.annotateCurrentSpan("linear.issue", ref.identifier)

      const [issue, latest, user] = yield* Effect.all(
        [
          linear.call(
            "get_issue",
            { id: ref.identifier, fields: ["title", "url", "status", "statusType", "assignee", "assigneeId"] },
            Issue,
          ),
          linear.call("list_comments", { issueId: ref.identifier, limit: 30, orderBy: "createdAt" }, Comments),
          me,
        ],
        { concurrency: 2 },
      ).pipe(
        Effect.catchTags({
          McpUnavailable: ({ operation, cause }) => Effect.fail(new LinearUnavailable({ operation, cause })),
          ToolFailed: ({ tool, problem }) =>
            Effect.fail(
              missing.test(problem)
                ? new IssueNotFound({ identifier: ref.identifier })
                : new LinearUnavailable({ operation: tool, cause: problem }),
            ),
        }),
      )

      const facts: LinearIssueFacts = {
        ref: { identifier: ref.identifier },
        title: issue.title,
        url: issue.url,
        state: { name: issue.status, type: issue.statusType },
        assignee: issue.assignee === null || issue.assigneeId === null ? null : { id: issue.assigneeId, name: issue.assignee },
        // Linear lists the newest comment first.
        comments: latest.comments
          .map((comment) => ({ id: comment.id, author: comment.author?.name ?? "an integration" }))
          .toReversed(),
        viewer: { id: user.id, name: user.name },
      }

      return facts
    })

    return Service.of({ read })
  })

/** The connection to Linear, still in need of an HTTP client and the gateway's sign-ins. */
export const layerWithoutDependencies = (
  config: Config,
): Layer.Layer<Service, never, HttpClient.HttpClient | SignIns.Service> => Layer.effect(Service, make(config))

/** The connection to Linear over `fetch`, still in need of the gateway's sign-ins. */
export const layer = (config: Config): Layer.Layer<Service, never, SignIns.Service> =>
  layerWithoutDependencies(config).pipe(Layer.provide(FetchHttpClient.layer))
