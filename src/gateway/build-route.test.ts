import { afterAll, beforeEach, expect, test } from "bun:test"
import { Effect, Layer, Redacted, Schema } from "effect"
import { BuildReadReply } from "../protocol/build.ts"
import { buildRoute } from "./build-route.ts"
import * as BuildReads from "./build-reads.ts"
import * as Buildkite from "./buildkite.ts"
import * as FakeMcp from "./fake-mcp.ts"
import * as SignIns from "./sign-ins.ts"

const commit = "ab12".repeat(10)
const address = "https://buildkite.com/lovable/bazel/builds/12"
const encodeBuildReply = Schema.encodeEffect(BuildReadReply)

const shown = {
  id: "build-12",
  number: 12,
  state: "passed",
  branch: "main",
  commit,
  message: "Speed up the build (#12)",
  web_url: address,
  created_at: "2026-11-20T10:00:00.000Z",
  started_at: "2026-11-20T10:01:00.000Z",
  finished_at: "2026-11-20T10:02:00.000Z",
  source: "webhook",
}

const build = {
  organization: "lovable",
  pipeline: "bazel",
  number: 12,
  state: "passed",
  url: address,
  branch: "main",
  commit,
  message: "Speed up the build (#12)",
  createdAt: Date.parse("2026-11-20T10:00:00.000Z"),
  startedAt: Date.parse("2026-11-20T10:01:00.000Z"),
  finishedAt: Date.parse("2026-11-20T10:02:00.000Z"),
  failedJobs: [],
}

interface Tools {
  readonly get_build: FakeMcp.Tool
  readonly list_jobs: FakeMcp.Tool
}

const working: Tools = {
  get_build: () => ({ value: shown }),
  list_jobs: () => ({ value: { items: [] } }),
}

let tools = working
let buildCalls = 0

const mcp = FakeMcp.make(
  {
    get_build: (input) => {
      buildCalls += 1
      expect(input).toEqual({ org_slug: "lovable", pipeline_slug: "bazel", build_number: "12" })

      return tools.get_build(input)
    },
    list_jobs: (input) => tools.list_jobs(input),
  },
  { streamed: false },
)

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: (request) =>
    request.headers.get("authorization") === "Bearer good"
      ? mcp.fetch(request)
      : new Response("sign in first\n", { status: 401 }),
})

afterAll(() => server.stop(true))

beforeEach(() => {
  tools = working
  buildCalls = 0
})

const signIns = (tokens: ReadonlyArray<string>) => {
  let renewals = 0

  return Layer.succeed(
    SignIns.Service,
    SignIns.Service.of({
      statuses: Effect.succeed({
        "webhook-proxy": "signed-out",
        linear: "signed-out",
        "incident-io": "signed-out",
        buildkite: "signed-in",
        spacelift: "signed-out",
      }),
      begin: () => Effect.succeed(""),
      complete: () => Effect.void,
      token: (system) => {
        const token = tokens[renewals]

        return token === undefined ? Effect.fail(new SignIns.NotSignedIn({ system })) : Effect.succeed(Redacted.make(token))
      },
      expire: (_system, refused) =>
        Effect.sync(() => {
          if (Redacted.value(refused) === tokens[renewals]) renewals += 1
        }),
    }),
  )
}

const reader = (tokens: ReadonlyArray<string> = ["good"]) => {
  const buildkite = Buildkite.layer({
    url: `http://127.0.0.1:${server.port}/buildkite`,
    organization: "lovable",
  }).pipe(Layer.provide(signIns(tokens)))

  const reads = BuildReads.layerWithoutDependencies.pipe(Layer.provide(buildkite))

  return {
    readBuild: (given: string) =>
      Effect.runPromise(
        Effect.flatMap(BuildReads.Service, (service) => service.read(given)).pipe(
          Effect.flatMap(encodeBuildReply),
          Effect.provide(reads),
        ),
      ),
  }
}

test("GET /builds reads and returns one build through the fake MCP server", async () => {
  const request = new Request(`http://ratchet.test/builds?url=${encodeURIComponent(address)}`)
  const response = await buildRoute(request, reader())

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual(build)
  expect(buildCalls).toBe(1)
})

test("GET /builds returns 400 without MCP I/O for a missing, malformed or other-organization address", async () => {
  const requests = [
    { url: "http://ratchet.test/builds", message: "A Buildkite build address is required" },
    { url: "http://ratchet.test/builds?url=not-a-build", message: "Not a Buildkite build address" },
    {
      url: "http://ratchet.test/builds?url=https://buildkite.com/another/bazel/builds/12",
      message: "The Buildkite sign-in reads lovable, not another",
    },
  ]

  for (const { url, message } of requests) {
    const response = await buildRoute(new Request(url), reader())

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: message })
  }

  expect(buildCalls).toBe(0)
})

test("GET /builds returns 404 for Buildkite's exact missing-build JSON body", async () => {
  tools = { ...working, get_build: () => ({ problem: '{"message":"Not Found"}' }) }

  const response = await buildRoute(
    new Request(`http://ratchet.test/builds?url=${encodeURIComponent(address)}`),
    reader(),
  )

  expect(response.status).toBe(404)
  expect(await response.json()).toEqual({ error: "Buildkite build not found" })
})

test("GET /builds returns a fixed 503 when Ratchet is not signed in to Buildkite", async () => {
  const response = await buildRoute(
    new Request(`http://ratchet.test/builds?url=${encodeURIComponent(address)}`),
    reader([]),
  )

  expect(response.status).toBe(503)
  expect(await response.json()).toEqual({ error: "Ratchet is not signed in to Buildkite" })
  expect(buildCalls).toBe(0)
})

test("GET /builds keeps upstream failures, permission text and secrets out of its fixed 503 body", async () => {
  const unavailable = [
    "organization not found",
    "authorization endpoint returned 404",
    "permission denied: fake-secret-value",
    "token expired: fake-secret-value",
    "The requested build was not found while checking another resource",
  ]

  for (const problem of unavailable) {
    tools = { ...working, get_build: () => ({ problem }) }

    const response = await buildRoute(
      new Request(`http://ratchet.test/builds?url=${encodeURIComponent(address)}`),
      reader(),
    )

    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body).toEqual({ error: "Buildkite is unavailable" })
    expect(JSON.stringify(body)).not.toContain(problem)
    expect(JSON.stringify(body)).not.toContain("fake-secret-value")
  }
})

test("GET /builds keeps a failed list_jobs secret out of its fixed 503 body", async () => {
  tools = {
    get_build: () => ({ value: { ...shown, state: "failed" } }),
    list_jobs: () => ({ problem: "jobs refused: fake-list-jobs-secret" }),
  }

  const response = await buildRoute(
    new Request(`http://ratchet.test/builds?url=${encodeURIComponent(address)}`),
    reader(),
  )

  const body = await response.json()

  expect(response.status).toBe(503)
  expect(body).toEqual({ error: "Buildkite is unavailable" })
  expect(JSON.stringify(body)).not.toContain("fake-list-jobs-secret")
})

test("/builds refuses non-GET requests without calling the gateway", async () => {
  let called = false

  const response = await buildRoute(new Request("http://ratchet.test/builds", { method: "POST" }), {
    readBuild: async () => {
      called = true

      return BuildReadReply.cases.Read.make({ build })
    },
  })

  expect(response.status).toBe(405)
  expect(response.headers.get("allow")).toBe("GET")
  expect(called).toBe(false)
})
