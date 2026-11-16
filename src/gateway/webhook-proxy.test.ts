import { afterAll, expect, test } from "bun:test"
import { Effect, Layer, Option, Redacted, Stream } from "effect"
import * as FakeWebhookProxy from "./fake-webhook-proxy.ts"
import * as SignIns from "./sign-ins.ts"
import * as WebhookProxy from "./webhook-proxy.ts"

const proxy = FakeWebhookProxy.make({ heartbeat: 50 })

// The proxy on a port of its own. It accepts the token "good" and refuses any other.
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  idleTimeout: 0,
  fetch: (request) => proxy.fetch(request, request.headers.get("authorization") === "Bearer good"),
})

afterAll(() => {
  proxy.stop()

  return server.stop(true)
})

/** The gateway's sign-ins with one token, and a note of the tokens that were refused. */
const signIns = (token: string, refused: Array<string>) =>
  Layer.succeed(
    SignIns.Service,
    SignIns.Service.of({
      statuses: Effect.succeed({
        "webhook-proxy": "signed-in",
        linear: "signed-out",
        "incident-io": "signed-out",
        buildkite: "signed-out",
        spacelift: "signed-out",
      }),
      begin: () => Effect.succeed(""),
      complete: () => Effect.void,
      token: () => Effect.succeed(Redacted.make(token)),
      expire: (_system, used) =>
        Effect.sync(() => {
          refused.push(Redacted.value(used))
        }),
    }),
  )

const listening = (token: string, refused: Array<string> = []) =>
  WebhookProxy.layer({ url: `http://127.0.0.1:${server.port}` }).pipe(Layer.provide(signIns(token, refused)))

const scope = "lovablelabs/lovable#12"

/** The first frames of a connection that are not heartbeats, once `act` has run against the open connection. */
const heard = (count: number, cursor: Option.Option<string>, act: () => void) =>
  Effect.gen(function* () {
    const proxied = yield* WebhookProxy.Service

    const frames = yield* proxied.frames([scope], cursor).pipe(
      // The first heartbeat says that the connection is open.
      Stream.tap((frame) => (WebhookProxy.Frame.guards.Heartbeat(frame) && frame.cursor === null ? Effect.sync(act) : Effect.void)),
      Stream.filter((frame) => !WebhookProxy.Frame.guards.Heartbeat(frame)),
      Stream.take(count),
      Stream.runCollect,
    )

    return [...frames]
  }).pipe(Effect.provide(listening("good")))

test("a connection hears the events of its pull requests and a gap, and none of another pull request's", async () => {
  const frames = await Effect.runPromise(
    heard(3, Option.none(), () => {
      proxy.emit({ repo: "lovablelabs/lovable", prs: [99], event_type: "issue_comment", action: "created" })
      proxy.emit({ repo: "lovablelabs/lovable", prs: [12], event_type: "check_run", action: "completed", conclusion: "failure" })
      proxy.gap()
      proxy.emit({ repo: "lovablelabs/lovable", prs: [12, 13], event_type: "pull_request_review", action: "submitted" })
    }),
  )

  const event = { id: "", repo: "lovablelabs/lovable" }

  // Every event has an ID of its own, which this test does not look at.
  expect(frames.map((frame) => (WebhookProxy.Frame.guards.Event(frame) ? { ...frame, id: "" } : frame))).toEqual([
    WebhookProxy.Frame.cases.Event.make({ ...event, type: "check_run", action: "completed", conclusion: "failure", pullRequests: [12] }),
    WebhookProxy.Frame.cases.Gap.make({}),
    WebhookProxy.Frame.cases.Event.make({ ...event, type: "pull_request_review", action: "submitted", conclusion: null, pullRequests: [12, 13] }),
  ])
})

test("a connection is taken up after the cursor it is given, and asks for the events that change a pull request", async () => {
  const cursor = "0190a000-0000-7000-8000-000000000001"

  await Effect.runPromise(heard(1, Option.some(cursor), () => proxy.emit({ repo: "lovablelabs/lovable", prs: [12], event_type: "issue_comment" })))

  expect(proxy.opened().at(-1)).toEqual({ scopes: [scope], cursor })
})

test("a token the proxy refuses is marked as used up, so the next connection renews it", async () => {
  const refused: Array<string> = []

  const failure = await Effect.runPromise(
    Effect.flatMap(WebhookProxy.Service, (proxied) => Effect.flip(Stream.runDrain(proxied.frames([scope], Option.none())))).pipe(
      Effect.provide(listening("stale", refused)),
    ),
  )

  expect(failure.message).toBe("the webhook proxy failed (stream): 401 Sign in required")
  expect(refused).toEqual(["stale"])
})

test("a heartbeat with an ID moves the cursor, and the proxy's advice on reconnecting is no frame", () => {
  const lines = ["retry: 1000", "", ": ping", "", "id: abc", ": ping", "", "event: expired", "data: {}", ""]
  let block: Parameters<typeof WebhookProxy.readLine>[0] = { id: null, event: null, data: [], comment: false }
  const frames: Array<WebhookProxy.Frame> = []

  for (const line of lines) {
    const [next, found] = WebhookProxy.readLine(block, line)
    block = next
    frames.push(...found)
  }

  expect(frames).toEqual([
    WebhookProxy.Frame.cases.Heartbeat.make({ cursor: null }),
    WebhookProxy.Frame.cases.Heartbeat.make({ cursor: "abc" }),
    WebhookProxy.Frame.cases.Expired.make({}),
  ])
})
