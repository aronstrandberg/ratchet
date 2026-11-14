import { afterAll, beforeEach, expect, test } from "bun:test"
import { Effect, Layer, Redacted } from "effect"
import { ReadReply, ResourceFacts, ResourceRef } from "../protocol/resource.ts"
import * as FakeMcp from "./fake-mcp.ts"
import * as GitHub from "./github.ts"
import * as IncidentIo from "./incident-io.ts"
import * as Linear from "./linear.ts"
import * as ResourceReads from "./resource-reads.ts"
import * as SignIns from "./sign-ins.ts"

/** The tools of Linear and incident.io that the gateway calls. */
interface Tools {
  readonly get_issue: FakeMcp.Tool
  readonly list_comments: FakeMcp.Tool
  readonly get_user: FakeMcp.Tool
  readonly incident_show: FakeMcp.Tool
}

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

// The two systems on a port of their own. Each accepts the token "good" and refuses any other.
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: (request) => {
    if (request.headers.get("authorization") !== "Bearer good") return new Response("sign in first\n", { status: 401 })

    return new URL(request.url).pathname === "/linear/mcp" ? linear.fetch(request) : incidentIo.fetch(request)
  },
})

afterAll(() => server.stop(true))

/** The gateway's sign-ins, handing out the tokens given in order. A token that is refused makes way for the next. */
const signIns = (tokens: ReadonlyArray<string>) => {
  let renewals = 0

  return Layer.succeed(
    SignIns.Service,
    SignIns.Service.of({
      statuses: Effect.succeed({ "webhook-proxy": "signed-out", linear: "signed-in", "incident-io": "signed-in" }),
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

/** The gateway's connections to Linear and incident.io, on the stand-in and the tokens given. */
const outside = (tokens: ReadonlyArray<string>) =>
  Layer.mergeAll(
    GitHub.layer({ token: Redacted.make("unused") }),
    Linear.layer({ url: `http://127.0.0.1:${server.port}/linear/mcp` }),
    IncidentIo.layer({ url: `http://127.0.0.1:${server.port}/incident/mcp` }),
  ).pipe(Layer.provide(signIns(tokens)))

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
