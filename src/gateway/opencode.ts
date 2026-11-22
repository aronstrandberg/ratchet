import { Context, Effect, Layer, Option, Redacted, Schema, Stream } from "effect"
import { Sse } from "effect/encoding"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { causeText } from "../failure.ts"
import { Card } from "../protocol/card.ts"
import { SessionId, type TaskId } from "../protocol/ids.ts"
import { type Question, SessionFact, SessionOrigin } from "../protocol/session.ts"
import type { Wake } from "../protocol/wake.ts"

/** The OpenCode service did not answer, or answered with something this adapter cannot read. */
export class OpenCodeUnavailable extends Schema.TaggedError<OpenCodeUnavailable>()("OpenCodeUnavailable", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `OpenCode failed (${this.operation}): ${causeText(this.cause)}`
  }
}

/** Where the OpenCode service listens, and the password of its `opencode` user. */
export interface Config {
  readonly url: string
  readonly password: Redacted.Redacted<string>
}

const SessionInfo = Schema.Struct({
  id: SessionId,
  title: Schema.optional(Schema.String),
  parentID: Schema.optional(SessionId),
  fork: Schema.optional(Schema.Struct({ sessionID: SessionId })),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  time: Schema.Struct({
    created: Schema.Number,
    updated: Schema.Number,
    archived: Schema.optional(Schema.Number),
  }),
})

/** A session as OpenCode holds it, without its messages. */
export type SessionInfo = typeof SessionInfo.Type

/** Everything the hub needs to converge on OpenCode's current state. */
export interface Snapshot {
  /** One `Opened` fact per main session that is not archived, oldest first. */
  readonly facts: ReadonlyArray<SessionFact>
  /** The same sessions as OpenCode holds them. */
  readonly sessions: ReadonlyArray<SessionInfo>
}

/** OpenCode's sessions, as the gateway reads them and acts on them. */
export interface Interface {
  /**
   * The state of every main session now.
   *
   * Oldest first puts a fork after the session it came from, so the hub knows the origin's task.
   */
  readonly snapshot: Effect.Effect<Snapshot, OpenCodeUnavailable>
  /**
   * The facts of OpenCode's live event stream, until the server closes it.
   *
   * The stream does not replay, so take a `snapshot` after each connect.
   */
  readonly facts: Stream.Stream<SessionFact, OpenCodeUnavailable>
  readonly session: (id: SessionId) => Effect.Effect<SessionInfo, OpenCodeUnavailable>
  /**
   * Records a session's task in the session's own metadata, under `ratchet.task`.
   *
   * It writes only when the value differs, because every write moves the session's `updated` time.
   */
  readonly recordTask: (info: SessionInfo, task: TaskId) => Effect.Effect<"written" | "unchanged", OpenCodeUnavailable>
  /**
   * Forks a session into a new one that holds the same history, names it, and gives it its first prompt.
   *
   * The fork starts in the directory of the session it came from.
   */
  readonly fork: (id: SessionId, title: string, prompt: string) => Effect.Effect<SessionId, OpenCodeUnavailable>
  /**
   * Puts a wake-up into its session and lets the session run. OpenCode admits the message durably, so it
   * survives a restart.
   *
   * Sending the same wake-up again adds nothing: OpenCode knows the message by its ID.
   */
  readonly wake: (wake: Wake) => Effect.Effect<void, OpenCodeUnavailable>
}

/** The gateway's connection to OpenCode. */
export class Service extends Context.Service<Service, Interface>()("@ratchet/gateway/OpenCode") {}

const encodeCard = Schema.encodeSync(Card)

const SessionPage = Schema.Struct({
  data: Schema.Array(SessionInfo),
  cursor: Schema.optional(Schema.Struct({ next: Schema.optional(Schema.NullOr(Schema.String)) })),
})

const Active = Schema.Struct({ data: Schema.Record(Schema.String, Schema.Unknown) })
const Forms = Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.String, title: Schema.String })) })

const Permissions = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({ id: Schema.String, action: Schema.String, resources: Schema.optional(Schema.Array(Schema.String)) }),
  ),
})

/** The events the adapter subscribes to. None of them carries message content. */
const eventTypes = [
  "session.created",
  "session.forked",
  "session.renamed",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.idle",
  "form.created",
  "form.replied",
  "form.cancelled",
  "permission.asked",
  "permission.replied",
] as const

const ServerEvent = Schema.Struct({
  type: Schema.String,
  data: Schema.Struct({
    sessionID: Schema.optional(SessionId),
    title: Schema.optional(Schema.String),
    id: Schema.optional(Schema.String),
    requestID: Schema.optional(Schema.String),
    action: Schema.optional(Schema.String),
    resources: Schema.optional(Schema.Array(Schema.String)),
    form: Schema.optional(Schema.Struct({ id: Schema.String, sessionID: SessionId, title: Schema.String })),
  }),
})

/** What Ratchet keeps in a session's metadata, under `ratchet`. */
const RecordedTask = Schema.Struct({ task: Schema.String })

const Fact = SessionFact.cases

const origin = (info: SessionInfo): SessionOrigin =>
  info.fork === undefined ? SessionOrigin.cases.Root.make({}) : SessionOrigin.cases.Fork.make({ of: info.fork.sessionID })

const permissionTitle = (action: string, resources: ReadonlyArray<string> | undefined) =>
  [action, ...(resources ?? [])].join(" ").slice(0, 200)

const base62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

/**
 * The ID of the message a wake-up becomes: the same for every attempt, so OpenCode admits a wake-up once.
 *
 * It has the form of OpenCode's own message IDs: 12 hex digits that grow with time, then 14 base62
 * characters, which here come from a hash of the wake-up and not from chance.
 */
export const messageId = (wake: Wake): Effect.Effect<string> =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${wake.session}/${wake.id}`))).pipe(
    Effect.map((digest) => {
      const time = ((BigInt(Math.trunc(wake.queuedAt)) * 0x1000n) & 0xffff_ffff_ffffn).toString(16).padStart(12, "0")
      const suffix = Array.from(new Uint8Array(digest).subarray(0, 14), (byte) => base62.charAt(byte % 62)).join("")

      return `msg_${time}${suffix}`
    }),
  )

/** Builds the connection on an HTTP client. Nothing is sent until an operation runs. */
export const make = (config: Config): Effect.Effect<Interface, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    /** Passes every response on, whatever its status. */
    const anyStatus = (yield* HttpClient.HttpClient).pipe(
      HttpClient.mapRequest((request) =>
        request.pipe(
          HttpClientRequest.prependUrl(config.url),
          HttpClientRequest.basicAuth("opencode", Redacted.value(config.password)),
        ),
      ),
    )

    const http = HttpClient.filterStatusOk(anyStatus)

    const failed = (operation: string) => (cause: unknown) => new OpenCodeUnavailable({ operation, cause })

    const getJson = <S extends Schema.Top>(schema: S, path: string, urlParams?: Readonly<Record<string, string>>) =>
      http
        .get(path, urlParams === undefined ? {} : { urlParams })
        .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)))

    const read = (id: SessionId) =>
      Effect.map(getJson(Schema.Struct({ data: SessionInfo }), `/api/session/${id}`), (body) => body.data)

    /** The forms and permission requests one session waits on. */
    const questionsOf = Effect.fnUntraced(function* (id: SessionId) {
      const forms = yield* getJson(Forms, `/api/session/${id}/form`)
      const permissions = yield* getJson(Permissions, `/api/session/${id}/permission`)

      return [
        ...forms.data.map((form): Question => ({ id: form.id, kind: "form", title: form.title })),
        ...permissions.data.map(
          (request): Question => ({
            id: request.id,
            kind: "permission",
            title: permissionTitle(request.action, request.resources),
          }),
        ),
      ]
    })

    /**
     * Finds the main session a session works for: itself, or the top of its chain of parents.
     *
     * `known` caches the answer for subagents, which never change parent.
     */
    const mainOf = (
      known: Map<SessionId, SessionId>,
      id: SessionId,
    ): Effect.Effect<SessionId, Effect.Error<ReturnType<typeof read>>> =>
      Effect.gen(function* () {
        const cached = known.get(id)

        if (cached !== undefined) return cached
        const info = yield* read(id)

        if (info.parentID === undefined) return id
        const main = yield* mainOf(known, info.parentID)
        known.set(id, main)

        return main
      })

    const snapshot = Effect.gen(function* () {
      const sessions: Array<SessionInfo> = []
      // parentID=null leaves out subagent sessions.
      const firstPage = { limit: "200", order: "asc", archived: "false", parentID: "null" }
      let cursor: string | undefined = undefined

      for (let page = 0; page < 50; page++) {
        const urlParams = cursor === undefined ? firstPage : { ...firstPage, cursor }
        const body: typeof SessionPage.Type = yield* getJson(SessionPage, "/api/session", urlParams)
        sessions.push(...body.data)
        cursor = body.cursor?.next ?? undefined

        if (cursor === undefined || body.data.length === 0) break
      }

      const mains = sessions
        .filter((info) => info.parentID === undefined && info.time.archived === undefined)
        .sort((a, b) => a.time.created - b.time.created)

      const active = yield* Schema.decodeUnknownEffect(Schema.Array(SessionId))(
        Object.keys((yield* getJson(Active, "/api/session/active")).data),
      )

      const isMain = new Set<SessionId>(mains.map((info) => info.id))
      const known = new Map<SessionId, SessionId>()
      const subagents = new Map<SessionId, Array<SessionId>>()
      const questions = new Map<SessionId, Array<Question>>()

      for (const id of active) {
        const main = yield* mainOf(known, id)

        if (main !== id) subagents.set(main, [...(subagents.get(main) ?? []), id])
        // Only a running session can wait on a form or a permission.
        const open = yield* questionsOf(id)

        if (open.length > 0) questions.set(main, [...(questions.get(main) ?? []), ...open])
      }

      return {
        sessions: mains,
        facts: mains.map((info) =>
          Fact.Opened.make({
            session: info.id,
            title: info.title ?? null,
            origin: origin(info),
            running: active.includes(info.id) && isMain.has(info.id),
            subagents: subagents.get(info.id) ?? [],
            questions: questions.get(info.id) ?? [],
          }),
        ),
      }
    }).pipe(Effect.mapError(failed("snapshot")), Effect.withSpan("OpenCode.snapshot"))

    const none: ReadonlyArray<SessionFact> = []

    const interpret = (known: Map<SessionId, SessionId>) =>
      Effect.fnUntraced(function* (event: typeof ServerEvent.Type) {
        const { data } = event
        const id = data.form?.sessionID ?? data.sessionID

        if (id === undefined) return none

        switch (event.type) {
          case "session.created":
          case "session.forked": {
            // The event does not say whether the session is a fork, so read the session.
            const info = yield* read(id)

            if (info.parentID !== undefined) return none

            return [
              Fact.Opened.make({
                session: id,
                title: info.title ?? null,
                origin: origin(info),
                running: false,
                subagents: [],
                questions: [],
              }),
            ]
          }

          case "session.renamed": {
            const main = yield* mainOf(known, id)

            return main !== id || data.title === undefined ? none : [Fact.Renamed.make({ session: id, title: data.title })]
          }

          case "session.execution.started": {
            const main = yield* mainOf(known, id)

            return [main === id ? Fact.Started.make({ session: id }) : Fact.SubagentStarted.make({ of: main, session: id })]
          }

          case "session.execution.succeeded":
          case "session.execution.failed":
          case "session.execution.interrupted":
          case "session.idle": {
            const main = yield* mainOf(known, id)

            return [main === id ? Fact.Idle.make({ session: id }) : Fact.SubagentStopped.make({ of: main, session: id })]
          }

          case "form.created": {
            if (data.form === undefined) return none
            const main = yield* mainOf(known, id)

            return [Fact.Asked.make({ of: main, question: { id: data.form.id, kind: "form", title: data.form.title } })]
          }

          case "permission.asked": {
            if (data.id === undefined || data.action === undefined) return none
            const main = yield* mainOf(known, id)
            const title = permissionTitle(data.action, data.resources)

            return [Fact.Asked.make({ of: main, question: { id: data.id, kind: "permission", title } })]
          }

          case "form.replied":
          case "form.cancelled":
          case "permission.replied": {
            const answered = event.type === "permission.replied" ? data.requestID : data.id

            if (answered === undefined) return none
            const main = yield* mainOf(known, id)

            return [Fact.Answered.make({ of: main, id: answered })]
          }

          default:
            return none
        }
      })

    const facts = Stream.suspend(() =>
      http.get("/api/event", { urlParams: { types: [...eventTypes] }, headers: { accept: "text/event-stream" } }).pipe(
        HttpClientResponse.stream,
        Stream.decodeText,
        Stream.pipeThroughChannel(Sse.decode()),
        Stream.mapEffect((event) => Schema.decodeUnknownEffect(Schema.fromJsonString(ServerEvent))(event.data)),
        Stream.mapEffect(interpret(new Map())),
        Stream.flattenIterable,
        Stream.mapError(failed("events")),
      ),
    )

    const recordTask = Effect.fn("OpenCode.recordTask")(function* (info: SessionInfo, task: TaskId) {
      const recorded = Schema.decodeUnknownOption(RecordedTask)(info.metadata?.["ratchet"])

      if (Option.isSome(recorded) && recorded.value.task === task) return "unchanged" as const
      yield* HttpClientRequest.patch(`/api/session/${info.id}`).pipe(
        HttpClientRequest.bodyJsonUnsafe({ metadata: { ...info.metadata, ratchet: { task } } }),
        http.execute,
        Effect.mapError(failed("record task")),
      )

      return "written" as const
    })

    const fork = Effect.fn("OpenCode.fork")(
      function* (id: SessionId, title: string, prompt: string) {
        const forked = yield* HttpClientRequest.post(`/api/session/${id}/fork`).pipe(
          HttpClientRequest.bodyJsonUnsafe({}),
          http.execute,
          Effect.flatMap(HttpClientResponse.schemaBodyJson(Schema.Struct({ data: SessionInfo }))),
        )

        yield* HttpClientRequest.patch(`/api/session/${forked.data.id}`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ title }),
          http.execute,
        )

        yield* HttpClientRequest.post(`/api/session/${forked.data.id}/prompt`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ text: prompt }),
          http.execute,
        )

        return forked.data.id
      },
      Effect.mapError(failed("fork")),
    )

    const wake = Effect.fn("OpenCode.wake")(
      function* (wake: Wake) {
        const id = yield* messageId(wake)
        yield* HttpClientRequest.post(`/api/session/${wake.session}/synthetic`).pipe(
          HttpClientRequest.bodyJsonUnsafe({
            id,
            text: wake.text,
            description: "Ratchet notification",
            metadata: { ratchet: { wake: wake.id, card: wake.card === null ? null : encodeCard(wake.card) } },
            resume: wake.resume,
          }),
          anyStatus.execute,
          // 409 says the session has taken this message in already, and that counts as delivered.
          Effect.flatMap(HttpClientResponse.filterStatus((status) => (status >= 200 && status < 300) || status === 409)),
        )
      },
      Effect.mapError(failed("wake")),
    )

    return Service.of({
      snapshot,
      facts,
      session: (id) => read(id).pipe(Effect.mapError(failed("read session"))),
      recordTask,
      fork,
      wake,
    })
  })

/** The connection to OpenCode, still in need of an HTTP client. */
export const layerWithoutDependencies = (config: Config): Layer.Layer<Service, never, HttpClient.HttpClient> =>
  Layer.effect(Service, make(config))

/** The connection to OpenCode over `fetch`. */
export const layer = (config: Config): Layer.Layer<Service> =>
  layerWithoutDependencies(config).pipe(Layer.provide(FetchHttpClient.layer))
