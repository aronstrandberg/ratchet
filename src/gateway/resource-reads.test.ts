import { afterAll, beforeEach, expect, test } from "bun:test"
import { Effect, Layer, Redacted } from "effect"
import { ReadReply, ResourceFacts, ResourceRef } from "../protocol/resource.ts"
import * as Buildkite from "./buildkite.ts"
import * as CommitBuilds from "./commit-builds.ts"
import * as CommitRuns from "./commit-runs.ts"
import * as FakeMcp from "./fake-mcp.ts"
import * as FakeSpacelift from "./fake-spacelift.ts"
import * as GitHub from "./github.ts"
import * as IncidentIo from "./incident-io.ts"
import * as Linear from "./linear.ts"
import * as ResourceReads from "./resource-reads.ts"
import * as SignIns from "./sign-ins.ts"
import * as Spacelift from "./spacelift.ts"

/** The tools of Linear and incident.io that the gateway calls. */
interface Tools {
  readonly get_issue: FakeMcp.Tool
  readonly list_comments: FakeMcp.Tool
  readonly get_user: FakeMcp.Tool
  readonly incident_show: FakeMcp.Tool
  readonly list_builds: FakeMcp.Tool
  readonly get_build: FakeMcp.Tool
  readonly list_jobs: FakeMcp.Tool
}

const commit = "ab12".repeat(10)

/** A build of the commit as Buildkite lists it: with its address, and without its pipeline or what started it. */
const listedBuild = (pipeline: string, number: number, state: string, branch = "main") => ({
  id: `${pipeline}-${number}`,
  branch,
  commit,
  state,
  number,
  message: "Speed up the build (#12)\n\nA long description.",
  created_at: `2026-11-16T10:00:0${number}.000Z`,
  web_url: `https://buildkite.com/lovable/${pipeline}/builds/${number}`,
})

const working: Tools = {
  get_issue: () => ({
    value: {
      id: "DX-1",
      title: "Move the export",
      url: "https://linear.app/lovable/issue/DX-1",
      status: "In Progress",
      statusType: "started",
      assignee: "aron",
      assigneeId: "u-me",
    },
  }),
  // Linear lists the newest comment first, with its text.
  list_comments: () => ({
    value: {
      comments: [
        { id: "c2", body: "Merged.", author: null },
        { id: "c1", body: "Can you take this one?", author: { id: "u-jifeng", name: "jifeng" } },
      ],
    },
  }),
  get_user: () => ({ value: { id: "u-me", name: "aron", email: "aron@example.com" } }),
  incident_show: (input) =>
    input["id"] === "INC-7"
      ? {
          value: {
            id: "01FDAG4SAP5TYPT98WGR2N7W91",
            reference: "INC-7",
            name: "Checkout is down",
            permalink: "https://app.incident.io/lovable/incidents/7",
            status: { id: "s1", name: "Investigating", category: "active" },
            severity: { id: "v1", name: "Major" },
          },
        }
      : { problem: '{"type":"not_found","errors":[{"code":"not_found","message":"incident not found"}]}' },
  list_builds: (input) => ({
    value: {
      items:
        input["commit"] === commit
          ? [
              listedBuild("nightly", 4, "failed"),
              listedBuild("deploy", 3, "running"),
              listedBuild("bazel", 2, "failed"),
              listedBuild("merge-queue", 1, "passed", "gh-readonly-queue/main/pr-12-abc"),
            ]
          : [],
    },
  }),
  get_build: (input) => ({ value: { source: input["pipeline_slug"] === "nightly" ? "schedule" : "webhook" } }),
  list_jobs: (input) => ({
    value: {
      items:
        input["state"] === "failed,timed_out"
          ? [
              { id: "j1", name: ":bazel: Test", step_key: "bazel-test", state: "failed" },
              { id: "j2", name: "Lint", step_key: null, state: "timed_out" },
            ]
          : [],
    },
  }),
}

/** What the stand-in answers now. A test that needs a tool to fail replaces it. */
let tools = working

const linear = FakeMcp.make(
  {
    get_issue: (input) => tools.get_issue(input),
    list_comments: (input) => tools.list_comments(input),
    get_user: (input) => tools.get_user(input),
  },
  { streamed: true },
)

const incidentIo = FakeMcp.make({ incident_show: (input) => tools.incident_show(input) }, { streamed: false })

const buildkite = FakeMcp.make(
  {
    list_builds: (input) => tools.list_builds(input),
    get_build: (input) => tools.get_build(input),
    list_jobs: (input) => tools.list_jobs(input),
  },
  { streamed: false },
)

const systems = new Map([
  ["/linear/mcp", linear],
  ["/incident/mcp", incidentIo],
  ["/buildkite/mcp", buildkite],
])

const proposed = "ef56".repeat(10)

/** What Spacelift holds: the plans of the pull request on two stacks, and the runs that its merge started. */
const spacelift = FakeSpacelift.make(() => [
  { id: "p1", stack: "iam", commit: proposed, type: "PROPOSED", state: "FINISHED" },
  { id: "p2", stack: "dns", commit: proposed, type: "PROPOSED", state: "FINISHED" },
  {
    id: "t1",
    stack: "iam",
    commit,
    type: "TRACKED",
    state: "UNCONFIRMED",
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_060,
    delta: { addCount: 2, changeCount: 0, deleteCount: 1 },
  },
  { id: "t2", stack: "iam", commit, type: "TRACKED", state: "SKIPPED", createdAt: 1_700_000_100 },
  { id: "t3", stack: "dns", commit, type: "TRACKED", state: "FINISHED", createdAt: 1_700_000_000 },
  // A stack that the push started and that did not plan the pull request.
  { id: "t4", stack: "billing", commit, type: "TRACKED", state: "UNCONFIRMED", createdAt: 1_700_000_000 },
])

// The systems on a port of their own. Each accepts the token "good" and refuses any other.
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: (request) => {
    const accepted = request.headers.get("authorization") === "Bearer good"

    // Spacelift answers a token it does not accept, with nothing in the answer.
    if (new URL(request.url).pathname === "/spacelift/graphql") return spacelift.fetch(request, accepted)

    if (!accepted) return new Response("sign in first\n", { status: 401 })

    return (systems.get(new URL(request.url).pathname) ?? linear).fetch(request)
  },
})

afterAll(() => server.stop(true))

/** The gateway's sign-ins, handing out the tokens given in order. A token that is refused makes way for the next. */
const signIns = (tokens: ReadonlyArray<string>) => {
  let renewals = 0

  return Layer.succeed(
    SignIns.Service,
    SignIns.Service.of({
      statuses: Effect.succeed({
        "webhook-proxy": "signed-out",
        linear: "signed-in",
        "incident-io": "signed-in",
        buildkite: "signed-in",
        spacelift: "signed-in",
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

/** GitHub, for a commit that is the only one of its push. Nothing in these tests reads a pull request. */
const github = Layer.succeed(
  GitHub.Service,
  GitHub.Service.of({
    read: (pullRequest) => Effect.fail(new GitHub.PullRequestNotFound(pullRequest)),
    landing: (merged) =>
      Effect.succeed({ title: "Speed up the build (#12)", branch: "main", proposed: ["ef56".repeat(10)], commits: [merged.commit] }),
  }),
)

/** The gateway's connections to Linear, incident.io, Buildkite and Spacelift, on the stand-ins and the tokens given. */
const outside = (tokens: ReadonlyArray<string>) =>
  Layer.mergeAll(
    Linear.layer({ url: `http://127.0.0.1:${server.port}/linear/mcp` }),
    IncidentIo.layer({ url: `http://127.0.0.1:${server.port}/incident/mcp` }),
    CommitBuilds.layerWithoutDependencies({ settle: 0, fresh: 0 }),
    CommitRuns.layerWithoutDependencies({ settle: 0 }),
  ).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        github,
        Buildkite.layer({ url: `http://127.0.0.1:${server.port}/buildkite/mcp`, organization: "lovable" }),
        Spacelift.layer({ url: `http://127.0.0.1:${server.port}/spacelift` }),
      ),
    ),
    Layer.provide(signIns(tokens)),
  )

const read = (ref: ResourceRef, tokens: ReadonlyArray<string> = ["good"]) =>
  Effect.runPromise(ResourceReads.read(ref).pipe(Effect.provide(outside(tokens))))

const issue = ResourceRef.cases.LinearIssue.make({ identifier: "DX-1" })
const incident = ResourceRef.cases.Incident.make({ number: 7 })

const issueRead = ReadReply.cases.Read.make({
  observed: ResourceFacts.cases.LinearIssue.make({
    facts: {
      ref: { identifier: "DX-1" },
      title: "Move the export",
      url: "https://linear.app/lovable/issue/DX-1",
      state: { name: "In Progress", type: "started" },
      assignee: { id: "u-me", name: "aron" },
      comments: [
        { id: "c1", author: "jifeng" },
        { id: "c2", author: "an integration" },
      ],
      viewer: { id: "u-me", name: "aron" },
    },
  }),
})

beforeEach(() => {
  tools = working
})

test("a Linear issue is read without its text: who commented, oldest first, and nothing of what they wrote", async () => {
  expect(await read(issue)).toEqual(issueRead)
})

test("an issue Linear does not have is answered as not found, and any other failure of a tool as unavailable", async () => {
  tools = { ...working, get_issue: () => ({ problem: '{"error":"invalid_request","message":"Could not find referenced Issue."}' }) }
  const missing = await read(issue)

  tools = { ...working, get_issue: () => ({ problem: "rate limited" }) }
  const failed = await read(issue)

  expect(missing).toEqual(ReadReply.cases.NotFound.make({}))
  expect(failed).toEqual(ReadReply.cases.Unavailable.make({ message: "Linear failed (get_issue): rate limited" }))
})

test("a system nobody is signed in to is answered as not signed in, with the system to sign in to", async () => {
  expect(await read(issue, [])).toEqual(ReadReply.cases.NotSignedIn.make({ system: "linear" }))
})

test("a token the system refuses is renewed once, and the read goes through with the new one", async () => {
  const twiceRefused = await read(issue, ["stale", "also stale"])

  expect(await read(issue, ["stale", "good"])).toEqual(issueRead)
  expect(ReadReply.guards.Unavailable(twiceRefused)).toBe(true)
})

test("a session the server forgot is opened again, and the read goes through", async () => {
  const replies = await Effect.runPromise(
    Effect.gen(function* () {
      const first = yield* ResourceReads.read(issue)
      linear.forget()

      return [first, yield* ResourceReads.read(issue)]
    }).pipe(Effect.provide(outside(["good"]))),
  )

  expect(replies).toEqual([issueRead, issueRead])
})

test("an incident is read by its reference, in the API's words for its status, and a missing one is not found", async () => {
  const shown = await read(incident)
  const missing = await read(ResourceRef.cases.Incident.make({ number: 8 }))

  expect(shown).toEqual(
    ReadReply.cases.Read.make({
      observed: ResourceFacts.cases.Incident.make({
        facts: {
          ref: { number: 7 },
          name: "Checkout is down",
          url: "https://app.incident.io/lovable/incidents/7",
          status: { name: "Investigating", category: "live" },
          severity: "Major",
        },
      }),
    }),
  )
  expect(missing).toEqual(ReadReply.cases.NotFound.make({}))
})

test("the builds that carry a commit leave out a build on a schedule and the merge queue's, and name the failed jobs", async () => {
  const merged = { owner: "lovablelabs", repo: "lovable", commit }
  const reply = await read(ResourceRef.cases.CommitBuilds.make(merged))

  expect(reply).toEqual(
    ReadReply.cases.Read.make({
      observed: ResourceFacts.cases.CommitBuilds.make({
        facts: {
          ref: merged,
          title: "Speed up the build (#12)",
          builds: [
            {
              id: "bazel-2",
              pipeline: "bazel",
              number: 2,
              state: "failed",
              url: "https://buildkite.com/lovable/bazel/builds/2",
              commit,
              createdAt: Date.parse("2026-11-16T10:00:02.000Z"),
              failedJobs: ["bazel-test", "Lint"],
            },
            {
              id: "deploy-3",
              pipeline: "deploy",
              number: 3,
              state: "running",
              url: "https://buildkite.com/lovable/deploy/builds/3",
              commit,
              createdAt: Date.parse("2026-11-16T10:00:03.000Z"),
              failedJobs: [],
            },
          ],
        },
      }),
    }),
  )
})

test("a commit-builds list_jobs failure keeps its existing caller-visible message", async () => {
  tools = { ...working, list_jobs: () => ({ problem: "jobs refused: caller-visible-detail" }) }
  const merged = { owner: "lovablelabs", repo: "lovable", commit }

  expect(await read(ResourceRef.cases.CommitBuilds.make(merged))).toEqual(
    ReadReply.cases.Unavailable.make({
      message: "Buildkite failed (list_jobs): jobs refused: caller-visible-detail",
    }),
  )
})

test("a commit that no build carries is answered as not found", async () => {
  const unbuilt = ResourceRef.cases.CommitBuilds.make({ owner: "lovablelabs", repo: "lovable", commit: "cd34".repeat(10) })

  expect(await read(unbuilt)).toEqual(ReadReply.cases.NotFound.make({}))
})

test("the runs that carry a commit are read for the stacks that planned its pull request, in milliseconds", async () => {
  const merged = { owner: "lovablelabs", repo: "lovable", commit }
  const url = `http://127.0.0.1:${server.port}/spacelift/stack`

  // The first token is refused, as Spacelift refuses one: with an answer that names nobody.
  const reply = await read(ResourceRef.cases.CommitRuns.make(merged), ["stale", "good"])

  expect(reply).toEqual(
    ReadReply.cases.Read.make({
      observed: ResourceFacts.cases.CommitRuns.make({
        facts: {
          ref: merged,
          title: "Speed up the build (#12)",
          runs: [
            {
              id: "t3",
              stack: "dns",
              state: "FINISHED",
              needsApproval: false,
              url: `${url}/dns/run/t3`,
              commit,
              createdAt: 1_700_000_000_000,
              updatedAt: 1_700_000_000_000,
              delta: null,
            },
            {
              id: "t1",
              stack: "iam",
              state: "UNCONFIRMED",
              needsApproval: false,
              url: `${url}/iam/run/t1`,
              commit,
              createdAt: 1_700_000_000_000,
              updatedAt: 1_700_000_060_000,
              delta: { add: 2, change: 0, delete: 1 },
            },
          ],
        },
      }),
    }),
  )
})

test("a token Spacelift keeps refusing makes the read unavailable", async () => {
  const merged = ResourceRef.cases.CommitRuns.make({ owner: "lovablelabs", repo: "lovable", commit })
  const refused = await read(merged, ["stale", "also stale"])

  expect(refused).toEqual(
    ReadReply.cases.Unavailable.make({ message: "Spacelift failed (planned): Spacelift did not accept the sign-in's token" }),
  )
})
