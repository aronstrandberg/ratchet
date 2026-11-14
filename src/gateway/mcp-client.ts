import { Effect, Option, Redacted, Ref, Schema, Semaphore, Stream } from "effect"
import { Sse } from "effect/encoding"
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http"
import { causeText } from "../failure.ts"
import * as SignIns from "./sign-ins.ts"
import type { System } from "./systems.ts"

/** A tool ran and answered that it failed. `problem` is the tool's own word for why. */
export class ToolFailed extends Schema.TaggedError<ToolFailed>()("ToolFailed", {
  tool: Schema.String,
  problem: Schema.String,
}) {
  override get message(): string {
    return `${this.tool} failed: ${this.problem}`
  }
}

/** The server did not answer, refused the request, or answered with something this client cannot read. */
export class McpUnavailable extends Schema.TaggedError<McpUnavailable>()("McpUnavailable", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `${this.operation}: ${causeText(this.cause)}`
  }
}

/** Where a system's MCP server is, and the sign-in whose token it accepts. */
export interface Config {
  readonly url: string
  readonly system: System
}

/** A system's tools, as its MCP server offers them over HTTP. */
export interface Interface {
  /**
   * Calls a tool and parses what it answers.
   *
   * The answer is the tool's structured content, or its text read as JSON when it has none. A token the
   * server refuses is renewed once before the call fails.
   */
  readonly call: <A>(
    tool: string,
    input: Readonly<Record<string, Schema.Json>>,
    answer: Schema.Codec<A, unknown>,
  ) => Effect.Effect<A, ToolFailed | McpUnavailable | SignIns.NotSignedIn>
}

/** The protocol version this client speaks. A server may answer with an older one, which is then used. */
const protocolVersion = "2025-06-18"

/** A JSON-RPC answer. A message that is neither a result nor an error is a notification, and is passed over. */
const Reply = Schema.Struct({
  result: Schema.optional(Schema.Json),
  error: Schema.optional(Schema.Struct({ message: Schema.String })),
})

const Opened = Schema.Struct({ protocolVersion: Schema.String })

const ToolResult = Schema.Struct({
  isError: Schema.optional(Schema.Boolean),
  structuredContent: Schema.optional(Schema.Json),
  content: Schema.optional(Schema.Array(Schema.Struct({ text: Schema.optional(Schema.String) }))),
})

const decodeReply = Schema.decodeUnknownEffect(Reply)
const decodeReplyText = Schema.decodeUnknownEffect(Schema.fromJsonString(Reply))
const decodeOpened = Schema.decodeUnknownEffect(Opened)
const decodeToolResult = Schema.decodeUnknownEffect(ToolResult)

/** What the server and this client agreed on when the session opened. */
interface Session {
  /** The session's name, for a server that keeps one. */
  readonly id: string | undefined
  readonly version: string
}

const answers = (reply: typeof Reply.Type) => reply.result !== undefined || reply.error !== undefined

/** Builds the client on an HTTP client and the gateway's sign-ins. Nothing is sent until a call runs. */
export const make = (config: Config): Effect.Effect<Interface, never, HttpClient.HttpClient | SignIns.Service> =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const signIns = yield* SignIns.Service
    const session = yield* Ref.make(Option.none<Session>())
    const opening = yield* Semaphore.make(1)
    const unavailable = (operation: string) => (cause: unknown) => new McpUnavailable({ operation, cause })

    const post = (operation: string, opened: Option.Option<Session>, message: Readonly<Record<string, Schema.Json>>) =>
      Effect.gen(function* () {
        const token = yield* signIns
          .token(config.system)
          .pipe(Effect.catchTag("SignInFailed", (failure) => Effect.fail(unavailable(operation)(failure))))

        const headers = Option.match(opened, {
          onNone: () => ({}),
          onSome: ({ id, version }) => ({ "mcp-protocol-version": version, "mcp-session-id": id }),
        })

        const response = yield* HttpClientRequest.post(config.url).pipe(
          HttpClientRequest.bearerToken(Redacted.value(token)),
          HttpClientRequest.setHeaders({ ...headers, accept: "application/json, text/event-stream" }),
          HttpClientRequest.bodyJsonUnsafe({ jsonrpc: "2.0", ...message }),
          http.execute,
          Effect.mapError(unavailable(operation)),
        )

        return { response, token }
      })

    /** Sends a message. A token the server refuses is marked as used up, and the message is sent once more. */
    const send = (operation: string, opened: Option.Option<Session>, message: Readonly<Record<string, Schema.Json>>) =>
      Effect.gen(function* () {
        const first = yield* post(operation, opened, message)

        if (first.response.status !== 401) return first.response

        yield* signIns.expire(config.system, first.token).pipe(Effect.mapError(unavailable(operation)))
        const second = yield* post(operation, opened, message)

        return second.response
      })

    /** The answer in a response: its body, or the first answer on its event stream. */
    const answerOf = (operation: string, response: HttpClientResponse.HttpClientResponse) =>
      Effect.gen(function* () {
        if (response.status < 200 || response.status >= 300) {
          return yield* new McpUnavailable({ operation, cause: `the server answered ${response.status}` })
        }

        const streamed = (response.headers["content-type"] ?? "").includes("text/event-stream")

        const read = streamed
          ? response.stream.pipe(
              Stream.decodeText,
              Stream.pipeThroughChannel(Sse.decode()),
              Stream.mapEffect((event) => decodeReplyText(event.data)),
              Stream.filter(answers),
              Stream.runHead,
              Effect.map(Option.getOrElse((): typeof Reply.Type => ({}))),
            )
          : Effect.flatMap(response.json, decodeReply)

        const reply = yield* Effect.mapError(read, unavailable(operation))

        if (reply.error !== undefined) return yield* new McpUnavailable({ operation, cause: reply.error.message })

        if (reply.result === undefined) return yield* new McpUnavailable({ operation, cause: "the server sent no answer" })

        return reply.result
      })

    /** Opens a session: the two messages every server expects before any other. */
    const open = Effect.gen(function* () {
      const response = yield* send("initialize", Option.none(), {
        id: 0,
        method: "initialize",
        params: { protocolVersion, capabilities: {}, clientInfo: { name: "ratchet", version: "1" } },
      })

      const agreed = yield* Effect.flatMap(answerOf("initialize", response), (result) =>
        Effect.mapError(decodeOpened(result), unavailable("initialize")),
      )

      const opened: Session = { id: response.headers["mcp-session-id"], version: agreed.protocolVersion }
      yield* send("initialize", Option.some(opened), { method: "notifications/initialized" })
      yield* Ref.set(session, Option.some(opened))

      return opened
    })

    /** The session, opened first when there is none. Calls that start together wait for one opening. */
    const opened = Effect.flatMap(Ref.get(session), Option.match({ onNone: () => open, onSome: Effect.succeed })).pipe(
      Semaphore.withPermits(opening, 1),
    )

    const call: Interface["call"] = (tool, input, answer) =>
      Effect.gen(function* () {
        const message = { id: 1, method: "tools/call", params: { name: tool, arguments: input } }
        const first = yield* send(tool, Option.some(yield* opened), message)
        // A server that no longer knows the session answers 404. A new session is opened, once.
        const response = first.status === 404 ? yield* send(tool, Option.some(yield* open), message) : first

        const result = yield* Effect.flatMap(answerOf(tool, response), (answered) =>
          Effect.mapError(decodeToolResult(answered), unavailable(tool)),
        )

        const text = result.content?.find((part) => part.text !== undefined)?.text

        if (result.isError === true) return yield* new ToolFailed({ tool, problem: text ?? "it gave no reason" })

        const parsed =
          result.structuredContent === undefined
            ? Schema.decodeUnknownEffect(Schema.fromJsonString(answer))(text)
            : Schema.decodeUnknownEffect(answer)(result.structuredContent)

        return yield* Effect.mapError(parsed, unavailable(tool))
      }).pipe(Effect.withSpan("McpClient.call", { attributes: { "mcp.system": config.system, "mcp.tool": tool } }))

    return { call }
  })
