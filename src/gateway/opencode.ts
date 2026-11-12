import { Effect, Schema, Stream } from "effect"
import { Sse } from "effect/encoding"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import type { SessionFact, SessionOrigin } from "../protocol/session.ts"

export interface Config {
  readonly url: string
  readonly password: string
}

const SessionInfo = Schema.Struct({
  id: Schema.String,
  title: Schema.optional(Schema.String),
  parentID: Schema.optional(Schema.String),
  fork: Schema.optional(Schema.Struct({ sessionID: Schema.String })),
  time: Schema.Struct({ created: Schema.Number, archived: Schema.optional(Schema.Number) }),
})
type SessionInfo = typeof SessionInfo.Type

const SessionPage = Schema.Struct({
  data: Schema.Array(SessionInfo),
  cursor: Schema.optional(Schema.Struct({ next: Schema.optional(Schema.NullOr(Schema.String)) })),
})

const Active = Schema.Struct({ data: Schema.Record(Schema.String, Schema.Unknown) })

/** The session events the adapter subscribes to. None of them carries message content. */
const eventTypes = [
  "session.created",
  "session.forked",
  "session.renamed",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.idle",
] as const

const ServerEvent = Schema.Struct({
  type: Schema.String,
  data: Schema.Struct({ sessionID: Schema.optional(Schema.String), title: Schema.optional(Schema.String) }),
})

const client = (config: Config) =>
  Effect.map(HttpClient.HttpClient, (http) =>
    http.pipe(
      HttpClient.mapRequest((request) =>
        request.pipe(HttpClientRequest.prependUrl(config.url), HttpClientRequest.basicAuth("opencode", config.password)),
      ),
      HttpClient.filterStatusOk,
    ),
  )

const origin = (info: SessionInfo): SessionOrigin =>
  info.fork !== undefined
    ? { _tag: "Fork", of: info.fork.sessionID }
    : info.parentID !== undefined
      ? { _tag: "Subagent", of: info.parentID }
      : { _tag: "Root" }

const opened = (info: SessionInfo, running: boolean): SessionFact => ({
  _tag: "Opened",
  session: info.id,
  title: info.title ?? null,
  origin: origin(info),
  running,
})

/** The IDs of the sessions that run now. */
const running = (config: Config) =>
  Effect.gen(function* () {
    const http = yield* client(config)
    const active = yield* http.get("/api/session/active").pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(Active)))
    return new Set(Object.keys(active.data))
  })

/**
 * One `Opened` fact for each session that is not archived and not a subagent, oldest first.
 *
 * Oldest first puts a fork after the session it came from, so the hub knows the origin's task.
 */
export const snapshot = (config: Config) =>
  Effect.gen(function* () {
    const http = yield* client(config)
    const active = yield* running(config)
    const sessions: Array<SessionInfo> = []
    let cursor: string | null | undefined = undefined
    for (let page = 0; page < 50; page++) {
      // parentID=null leaves out subagent sessions.
      const urlParams: Record<string, string> = { limit: "200", order: "asc", archived: "false", parentID: "null" }
      if (typeof cursor === "string") urlParams["cursor"] = cursor
      const body = yield* http
        .get("/api/session", { urlParams })
        .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(SessionPage)))
      sessions.push(...body.data)
      cursor = body.cursor?.next
      if (typeof cursor !== "string" || body.data.length === 0) break
    }
    return sessions
      .filter((info) => info.parentID === undefined && info.time.archived === undefined)
      .sort((a, b) => a.time.created - b.time.created)
      .map((info) => opened(info, active.has(info.id)))
  }).pipe(Effect.provide(FetchHttpClient.layer))

const session = (config: Config, id: string) =>
  Effect.gen(function* () {
    const http = yield* client(config)
    const body = yield* http
      .get(`/api/session/${id}`)
      .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(Schema.Struct({ data: SessionInfo }))))
    return body.data
  })

/**
 * The facts of OpenCode's live event stream, until the server closes it.
 *
 * The stream does not replay, so take a `snapshot` after each connect.
 */
export const facts = (config: Config): Stream.Stream<SessionFact, unknown> =>
  Stream.unwrap(
    Effect.map(client(config), (http) =>
      http.get("/api/event", { urlParams: { types: [...eventTypes] }, headers: { accept: "text/event-stream" } }).pipe(
        HttpClientResponse.stream,
        Stream.decodeText,
        Stream.pipeThroughChannel(Sse.decode()),
        Stream.mapEffect((event) => Schema.decodeUnknownEffect(Schema.fromJsonString(ServerEvent))(event.data)),
        Stream.mapEffect((event): Effect.Effect<ReadonlyArray<SessionFact>, unknown, HttpClient.HttpClient> => {
          const id = event.data.sessionID
          if (id === undefined) return Effect.succeed([])
          switch (event.type) {
            case "session.created":
            case "session.forked":
              // The event does not say whether the session is a fork, so read the session.
              return Effect.map(session(config, id), (info) => [opened(info, false)])
            case "session.renamed":
              return Effect.succeed(
                event.data.title === undefined ? [] : [{ _tag: "Renamed", session: id, title: event.data.title }],
              )
            case "session.execution.started":
              return Effect.succeed([{ _tag: "Started", session: id }])
            case "session.execution.succeeded":
            case "session.execution.failed":
            case "session.execution.interrupted":
            case "session.idle":
              return Effect.succeed([{ _tag: "Idle", session: id }])
            default:
              return Effect.succeed([])
          }
        }),
        Stream.flattenIterable,
      ),
    ),
  ).pipe(Stream.provide(FetchHttpClient.layer))
