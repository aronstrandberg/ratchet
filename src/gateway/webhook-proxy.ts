import { Context, Effect, Layer, Option, Redacted, Schema, Stream } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { causeText } from "../failure.ts"
import * as SignIns from "./sign-ins.ts"

/** The webhook proxy did not answer, refused the connection, or sent something this adapter cannot read. */
export class ProxyUnavailable extends Schema.TaggedError<ProxyUnavailable>()("ProxyUnavailable", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `the webhook proxy failed (${this.operation}): ${causeText(this.cause)}`
  }
}

/** Where the webhook proxy is, such as `https://lov-webhook-proxy.lovable.app`. */
export interface Config {
  readonly url: string
}

/**
 * One frame of the proxy's stream.
 *
 * A frame says that something happened and never what: whoever hears it reads the state from GitHub.
 */
export const Frame = Schema.TaggedUnion({
  /** GitHub sent an event that concerns the pull requests named. */
  Event: {
    id: Schema.String,
    /** GitHub's name for the event, such as `check_run` or `pull_request_review`. */
    type: Schema.String,
    action: Schema.NullOr(Schema.String),
    /** How a check ended, such as `success` or `failure`. Null for other events and for a check that has not ended. */
    conclusion: Schema.NullOr(Schema.String),
    /** The repository, as `owner/repo`. */
    repo: Schema.String,
    pullRequests: Schema.Array(Schema.Int),
  },
  /** The proxy says it is there. With a cursor, the stream can be taken up after this moment. */
  Heartbeat: { cursor: Schema.NullOr(Schema.String) },
  /** The proxy no longer holds the events after the cursor it was given, so some were missed. */
  Gap: {},
  /** The stream reached the end of its life. The next connection opens a new one. */
  Expired: {},
})

export type Frame = typeof Frame.Type

/** The webhook proxy's live stream of GitHub events, as the gateway hears it. */
export interface Interface {
  /**
   * One connection to the stream of the scopes given, each `owner/repo#number`, taken up after `cursor`.
   *
   * It ends when the proxy closes it, which it does about every ten minutes, and when nothing is heard for
   * 45 seconds. A cursor older than what the proxy keeps is answered with a `Gap`.
   */
  readonly frames: (
    scopes: ReadonlyArray<string>,
    cursor: Option.Option<string>,
  ) => Stream.Stream<Frame, ProxyUnavailable | SignIns.NotSignedIn>
}

/** The gateway's connection to the webhook proxy. */
export class Service extends Context.Service<Service, Interface>()("@ratchet/gateway/WebhookProxy") {}

/**
 * The GitHub events that can change what the hub holds about a pull request.
 *
 * A label or an assignee is left out: it would cost a read for nothing.
 */
const events = [
  "pull_request.synchronize",
  "pull_request.edited",
  "pull_request.closed",
  "pull_request.reopened",
  "pull_request.converted_to_draft",
  "pull_request.ready_for_review",
  "pull_request.enqueued",
  "pull_request.dequeued",
  "pull_request_review",
  "pull_request_review_comment",
  "pull_request_review_thread",
  "issue_comment",
  "check_run.completed",
]

/** The proxy sends a heartbeat every 15 seconds, so a connection that is silent this long is dead. */
const silence = "45 seconds"

const Sent = Schema.Struct({
  id: Schema.String,
  event_type: Schema.String,
  action: Schema.optional(Schema.NullOr(Schema.String)),
  conclusion: Schema.optional(Schema.NullOr(Schema.String)),
  repo: Schema.NullOr(Schema.String),
  prs: Schema.optional(Schema.Array(Schema.Int)),
})

const decodeSent = Schema.decodeUnknownOption(Schema.fromJsonString(Sent))

/** One block of a server-sent event stream, as its lines gave it. */
interface Block {
  readonly id: string | null
  readonly event: string | null
  readonly data: ReadonlyArray<string>
  /** Whether the block held a comment line, which is how the proxy sends a heartbeat. */
  readonly comment: boolean
}

const blank: Block = { id: null, event: null, data: [], comment: false }

/** The frame a block stands for. A block this adapter does not know, such as the proxy's `retry` advice, is none. */
export const frameOf = (block: Block): Option.Option<Frame> => {
  if (block.event === "gap") return Option.some(Frame.cases.Gap.make({}))

  if (block.event === "expired") return Option.some(Frame.cases.Expired.make({}))

  if (block.event === "event") {
    return Option.flatMap(decodeSent(block.data.join("\n")), (sent) =>
      sent.repo === null
        ? Option.none()
        : Option.some(
            Frame.cases.Event.make({
              id: sent.id,
              type: sent.event_type,
              action: sent.action ?? null,
              conclusion: sent.conclusion ?? null,
              repo: sent.repo.toLowerCase(),
              pullRequests: sent.prs ?? [],
            }),
          ),
    )
  }

  return block.comment || block.id !== null ? Option.some(Frame.cases.Heartbeat.make({ cursor: block.id })) : Option.none()
}

/** Takes one line of a server-sent event stream into the block being read, and gives the frame a blank line ends. */
export const readLine = (block: Block, line: string): readonly [Block, ReadonlyArray<Frame>] => {
  if (line === "") return [blank, Option.toArray(frameOf(block))]

  if (line.startsWith(":")) return [{ ...block, comment: true }, []]
  const colon = line.indexOf(":")
  const field = colon === -1 ? line : line.slice(0, colon)
  const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "")

  switch (field) {
    case "id":
      return [{ ...block, id: value }, []]
    case "event":
      return [{ ...block, event: value }, []]
    case "data":
      return [{ ...block, data: [...block.data, value] }, []]
    default:
      return [block, []]
  }
}

/** Builds the connection on an HTTP client and the gateway's sign-ins. Nothing is sent until a stream runs. */
export const make = (config: Config): Effect.Effect<Interface, never, HttpClient.HttpClient | SignIns.Service> =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const signIns = yield* SignIns.Service
    const unavailable = (cause: unknown) => new ProxyUnavailable({ operation: "stream", cause })

    const connect = Effect.fn("WebhookProxy.connect")(function* (scopes: ReadonlyArray<string>, cursor: Option.Option<string>) {
      const token = yield* signIns
        .token("webhook-proxy")
        .pipe(Effect.catchTag("SignInFailed", (failure) => Effect.fail(unavailable(failure))))

      const address = new URL(`${config.url}/api/public/streams`)

      for (const scope of scopes) address.searchParams.append("scope", scope)
      address.searchParams.set("event_type", events.join(","))

      const response = yield* HttpClientRequest.get(address.toString()).pipe(
        HttpClientRequest.bearerToken(Redacted.value(token)),
        HttpClientRequest.setHeaders({
          accept: "text/event-stream",
          ...Option.match(cursor, { onNone: () => ({}), onSome: (id) => ({ "last-event-id": id }) }),
        }),
        http.execute,
        Effect.mapError(unavailable),
      )

      if (response.status === 200) return response

      // The next connection renews a token the proxy refused.
      if (response.status === 401) yield* signIns.expire("webhook-proxy", token).pipe(Effect.mapError(unavailable))
      const said = yield* response.text.pipe(Effect.catch(() => Effect.succeed("")))

      return yield* new ProxyUnavailable({ operation: "stream", cause: `${response.status} ${said.slice(0, 300)}`.trim() })
    })

    const frames: Interface["frames"] = (scopes, cursor) =>
      Stream.unwrap(Effect.map(connect(scopes, cursor), (response) => Stream.mapError(response.stream, unavailable))).pipe(
        Stream.decodeText,
        Stream.splitLines,
        Stream.mapAccum(() => blank, readLine),
        Stream.timeout(silence),
      )

    return Service.of({ frames })
  })

/** The connection to the webhook proxy, still in need of an HTTP client and the gateway's sign-ins. */
export const layerWithoutDependencies = (
  config: Config,
): Layer.Layer<Service, never, HttpClient.HttpClient | SignIns.Service> => Layer.effect(Service, make(config))

/** The connection to the webhook proxy over `fetch`, still in need of the gateway's sign-ins. */
export const layer = (config: Config): Layer.Layer<Service, never, SignIns.Service> =>
  layerWithoutDependencies(config).pipe(Layer.provide(FetchHttpClient.layer))
