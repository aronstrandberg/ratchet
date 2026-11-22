import { afterAll, beforeEach, expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer, Redacted, Tracer } from "effect"
import { BuildAddressRef } from "../protocol/build.ts"
import * as Buildkite from "./buildkite.ts"
import * as FakeMcp from "./fake-mcp.ts"
import * as SignIns from "./sign-ins.ts"

const commit = "ab12".repeat(10)
const ref = BuildAddressRef.make({ organization: "lovable", pipeline: "bazel", number: 12 })

interface Tools {
  readonly get_build: FakeMcp.Tool
  readonly list_jobs: FakeMcp.Tool
}

const shown = {
  id: "build-12",
  number: 12,
  state: "passed",
  branch: "main",
  commit,
  message: "Speed up the build (#12)",
  web_url: "https://buildkite.com/lovable/bazel/builds/12",
  created_at: "2026-11-20T10:00:00.000Z",
  started_at: "2026-11-20T10:01:00.000Z",
  finished_at: "2026-11-20T10:02:00.000Z",
  source: "webhook",
}

const working: Tools = {
  get_build: () => ({ value: shown }),
  list_jobs: () => ({ value: { items: [] } }),
}

let tools = working

const mcp = FakeMcp.make(
  {
    get_build: (input) => tools.get_build(input),
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

const outside = (tokens: ReadonlyArray<string>, organization: string) =>
  Buildkite.layer({ url: `http://127.0.0.1:${server.port}/buildkite`, organization }).pipe(
    Layer.provide(signIns(tokens)),
  )

const read = (build: BuildAddressRef, tokens: ReadonlyArray<string> = ["good"], organization = "lovable") =>
  Effect.runPromise(
    Effect.flatMap(Buildkite.Service, (buildkite) => buildkite.read(build)).pipe(Effect.provide(outside(tokens, organization))),
  )

const readTwice = (build: BuildAddressRef) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const buildkite = yield* Buildkite.Service
      const first = yield* buildkite.read(build)
      const second = yield* buildkite.read(build)

      return [first, second] as const
    }).pipe(Effect.provide(outside(["good"], "lovable"))),
  )

test("a passed build is read through Buildkite's get_build tool", async () => {
  expect(await read(ref)).toEqual({
    organization: "lovable",
    pipeline: "bazel",
    number: 12,
    state: "passed",
    url: "https://buildkite.com/lovable/bazel/builds/12",
    branch: "main",
    commit,
    message: "Speed up the build (#12)",
    createdAt: Date.parse("2026-11-20T10:00:00.000Z"),
    startedAt: Date.parse("2026-11-20T10:01:00.000Z"),
    finishedAt: Date.parse("2026-11-20T10:02:00.000Z"),
    failedJobs: [],
  })
})

test("a successful build read annotates its build identity, result and failed-job count", async () => {
  const spans: Array<Tracer.NativeSpan> = []

  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options)
      spans.push(span)

      return span
    },
  })

  await Effect.runPromise(
    Effect.flatMap(Buildkite.Service, (buildkite) => buildkite.read(ref)).pipe(
      Effect.provide(outside(["good"], "lovable")),
      Effect.provideService(Tracer.Tracer, tracer),
    ),
  )

  const span = spans.find(({ name }) => name === "Buildkite.read")

  expect(Object.fromEntries(span?.attributes ?? [])).toMatchObject({
    "buildkite.organization": "lovable",
    "buildkite.pipeline": "bazel",
    "buildkite.build_number": 12,
    "buildkite.state": "passed",
    "buildkite.failed_job_count": 0,
  })
})

test("a running build may omit its ID, message and start and finish times", async () => {
  tools = {
    ...working,
    get_build: () => ({
      value: {
        number: 12,
        state: "running",
        branch: "main",
        commit,
        web_url: "https://buildkite.com/lovable/bazel/builds/12",
        created_at: "2026-11-20T10:00:00.000Z",
      },
    }),
  }

  expect(await read(ref)).toEqual({
    organization: "lovable",
    pipeline: "bazel",
    number: 12,
    state: "running",
    url: "https://buildkite.com/lovable/bazel/builds/12",
    branch: "main",
    commit,
    message: null,
    createdAt: Date.parse("2026-11-20T10:00:00.000Z"),
    startedAt: null,
    finishedAt: null,
    failedJobs: [],
  })
})

test("a failed build includes failed step keys or names, and remembers them once the build is over", async () => {
  let jobReads = 0
  tools = {
    get_build: () => ({ value: { ...shown, state: "failed" } }),
    list_jobs: (input) => {
      jobReads += 1
      expect(input["state"]).toBe("failed,timed_out")

      return {
        value: {
          items: [
            { name: ":bazel: Test", step_key: "bazel-test" },
            { name: "Lint", step_key: null },
          ],
        },
      }
    },
  }

  const [first, second] = await readTwice(ref)

  expect(first).toEqual({ ...second, state: "failed", failedJobs: ["bazel-test", "Lint"] })
  expect(jobReads).toBe(1)
})

test("a malformed get_build answer is unavailable", async () => {
  tools = { ...working, get_build: () => ({ value: { number: 12, state: "passed" } }) }

  expect(read(ref)).rejects.toBeInstanceOf(Buildkite.BuildkiteUnavailable)

  tools = { ...working, get_build: () => ({ value: { ...shown, number: 0 } }) }

  expect(read(ref)).rejects.toBeInstanceOf(Buildkite.BuildkiteUnavailable)
})

test("only exact get_build not-found representations are distinct from Buildkite being unavailable", async () => {
  const missing = ["Not Found", "Build not found", "No such build", "404", '{"message":"Not Found"}']

  for (const problem of missing) {
    tools = { ...working, get_build: () => ({ problem }) }

    expect(read(ref)).rejects.toEqual(new Buildkite.BuildNotFound({ ref }))
  }
})

test("errors that only mention not found or 404 remain unavailable", async () => {
  const unavailable = [
    "organization not found",
    "authorization endpoint returned 404",
    "permission denied",
    "token expired",
    "The requested build was not found while checking another resource",
  ]

  for (const problem of unavailable) {
    tools = { ...working, get_build: () => ({ problem }) }

    expect(read(ref)).rejects.toBeInstanceOf(Buildkite.BuildkiteUnavailable)
  }
})

test("a failed tool call annotates only safe structured diagnostics", async () => {
  tools = { ...working, get_build: () => ({ problem: "permission denied: fake-secret-value" }) }

  const spans: Array<Tracer.NativeSpan> = []

  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options)
      spans.push(span)

      return span
    },
  })

  await Effect.runPromise(
    Effect.flatMap(Buildkite.Service, (buildkite) => buildkite.read(ref)).pipe(
      Effect.exit,
      Effect.provide(outside(["good"], "lovable")),
      Effect.provideService(Tracer.Tracer, tracer),
    ),
  )

  const readSpan = spans.find(({ name }) => name === "Buildkite.read")

  const mcpSpan = spans.find(
    (span) => span.name === "McpClient.call" && span.attributes.get("mcp.tool") === "get_build",
  )

  const attributes = spans.flatMap((span) => [...span.attributes])

  const failures = spans.flatMap(({ status }) =>
    "exit" in status
      ? Exit.match(status.exit, { onFailure: (cause) => [Cause.pretty(cause)], onSuccess: () => [] })
      : [],
  )

  expect(Object.fromEntries(readSpan?.attributes ?? [])).toMatchObject({
    "buildkite.operation": "read",
    "buildkite.error_tag": "BuildkiteUnavailable",
  })
  expect(Object.fromEntries(mcpSpan?.attributes ?? [])).toMatchObject({
    "mcp.tool": "get_build",
    "mcp.error_tag": "ToolFailed",
  })
  expect(JSON.stringify(attributes)).not.toContain("fake-secret-value")
  expect(failures.join("\n")).not.toContain("fake-secret-value")
})

test("a failed list_jobs call stays out of every span in a single failed-build read", async () => {
  tools = {
    get_build: () => ({ value: { ...shown, state: "failed" } }),
    list_jobs: () => ({ problem: "jobs refused: fake-list-jobs-secret" }),
  }

  const spans: Array<Tracer.NativeSpan> = []

  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options)
      spans.push(span)

      return span
    },
  })

  await Effect.runPromise(
    Effect.flatMap(Buildkite.Service, (buildkite) => buildkite.read(ref)).pipe(
      Effect.exit,
      Effect.provide(outside(["good"], "lovable")),
      Effect.provideService(Tracer.Tracer, tracer),
    ),
  )

  const relevant = spans.filter(({ name }) =>
    ["Buildkite.read", "Buildkite.failedJobs", "McpClient.call"].includes(name),
  )

  const attributesOf = (name: string) => Object.fromEntries(relevant.find((span) => span.name === name)?.attributes ?? [])

  const listJobsSpan = relevant.find(
    (span) => span.name === "McpClient.call" && span.attributes.get("mcp.tool") === "list_jobs",
  )

  expect(relevant.map(({ name }) => name)).toEqual(
    expect.arrayContaining(["Buildkite.read", "Buildkite.failedJobs", "McpClient.call"]),
  )
  expect(attributesOf("Buildkite.read")).toMatchObject({
    "buildkite.operation": "read",
    "buildkite.error_tag": "BuildkiteUnavailable",
  })
  expect(attributesOf("Buildkite.failedJobs")).toMatchObject({
    "buildkite.operation": "failedJobs",
    "buildkite.error_tag": "BuildkiteUnavailable",
  })
  expect(Object.fromEntries(listJobsSpan?.attributes ?? [])).toMatchObject({
    "mcp.tool": "list_jobs",
    "mcp.error_tag": "ToolFailed",
  })

  const failures = relevant.flatMap(({ status }) =>
    "exit" in status
      ? Exit.match(status.exit, { onFailure: (cause) => [Cause.pretty(cause)], onSuccess: () => [] })
      : [],
  )

  const statuses = relevant.flatMap(({ status }) =>
    "exit" in status
      ? Exit.match(status.exit, { onFailure: (cause) => [Cause.pretty(cause)], onSuccess: (value) => [value] })
      : [],
  )

  const events = relevant.flatMap((span) =>
    span.events.map(([name, , attributes]) => ({ name, attributes })),
  )

  const telemetry = JSON.stringify({ attributes: relevant.flatMap((span) => [...span.attributes]), events })

  expect(failures.join("\n")).not.toContain("fake-list-jobs-secret")
  expect(JSON.stringify(statuses)).not.toContain("fake-list-jobs-secret")
  expect(telemetry).not.toContain("fake-list-jobs-secret")
})

test("a build in another organization is refused before Buildkite is called", async () => {
  let called = false
  tools = {
    ...working,
    get_build: () => {
      called = true

      return { value: shown }
    },
  }
  const other = BuildAddressRef.make({ organization: "another", pipeline: "bazel", number: 12 })

  expect(read(other)).rejects.toEqual(new Buildkite.BuildOrganizationRefused({ configured: "lovable", requested: "another" }))
  expect(called).toBe(false)
})

test("a build read says when the gateway is not signed in to Buildkite", async () => {
  expect(read(ref, [])).rejects.toEqual(new SignIns.NotSignedIn({ system: "buildkite" }))
})
