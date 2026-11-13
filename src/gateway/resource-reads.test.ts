import { expect, test } from "bun:test"
import { Effect, Layer, Redacted } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { ReadReply, ResourceFacts, ResourceRef } from "../protocol/resource.ts"
import * as GitHub from "./github.ts"
import * as IncidentIo from "./incident-io.ts"
import * as Linear from "./linear.ts"
import * as ResourceReads from "./resource-reads.ts"

/** What each system answers, by the address the gateway asked. */
type Answers = Readonly<Record<string, { readonly status: number; readonly body: object }>>

/** The gateway's three connections, on an HTTP client that answers from a table and reaches no network. */
const outside = (answers: Answers) => {
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      const answer = answers[request.url] ?? { status: 500, body: {} }

      return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(answer.body, { status: answer.status })))
    }),
  )

  const key = Redacted.make("a key")

  return Layer.mergeAll(
    GitHub.layerWithoutDependencies({ token: key }),
    Linear.layerWithoutDependencies({ url: "https://linear.test/graphql", key }),
    IncidentIo.layerWithoutDependencies({ url: "https://incident.test", key }),
  ).pipe(Layer.provide(http))
}

test("a system the gateway has no key for is answered as not configured, with the setting to fill in", async () => {
  const reply = await Effect.runPromise(
    ResourceReads.read(issue).pipe(
      Effect.provide(Layer.mergeAll(outside({}), Linear.layerNotConfigured, IncidentIo.layerNotConfigured)),
    ),
  )

  expect(reply).toEqual(ReadReply.cases.NotConfigured.make({ setting: "LINEAR_API_KEY" }))
})

const read = (ref: ResourceRef, answers: Answers) =>
  Effect.runPromise(ResourceReads.read(ref).pipe(Effect.provide(outside(answers))))

const issue = ResourceRef.cases.LinearIssue.make({ identifier: "DX-1" })
const incident = ResourceRef.cases.Incident.make({ number: 7 })

test("a Linear issue is read without its text: who commented, and nothing of what they wrote", async () => {
  const reply = await read(issue, {
    "https://linear.test/graphql": {
      status: 200,
      body: {
        data: {
          viewer: { id: "u-me", displayName: "aron" },
          issue: {
            identifier: "DX-1",
            title: "Move the export",
            url: "https://linear.app/lovable/issue/DX-1",
            state: { name: "In Progress", type: "started" },
            assignee: { id: "u-me", displayName: "aron" },
            comments: {
              nodes: [
                { id: "c1", user: { displayName: "jifeng" }, botActor: null },
                { id: "c2", user: null, botActor: { name: "GitHub" } },
              ],
            },
          },
        },
      },
    },
  })

  expect(reply).toEqual(
    ReadReply.cases.Read.make({
      observed: ResourceFacts.cases.LinearIssue.make({
        facts: {
          ref: { identifier: "DX-1" },
          title: "Move the export",
          url: "https://linear.app/lovable/issue/DX-1",
          state: { name: "In Progress", type: "started" },
          assignee: { id: "u-me", name: "aron" },
          comments: [
            { id: "c1", author: "jifeng" },
            { id: "c2", author: "GitHub" },
          ],
          viewer: { id: "u-me", name: "aron" },
        },
      }),
    }),
  )
})

test("an issue Linear does not have is answered as not found, and a refused key as unavailable", async () => {
  const missing = await read(issue, {
    "https://linear.test/graphql": {
      status: 200,
      body: { errors: [{ message: "Entity not found: Issue" }], data: { viewer: { id: "u", displayName: "a" }, issue: null } },
    },
  })

  const refused = await read(issue, {
    "https://linear.test/graphql": { status: 401, body: { errors: [{ message: "Authentication required" }] } },
  })

  expect(missing).toEqual(ReadReply.cases.NotFound.make({}))
  expect(refused).toMatchObject({ message: expect.stringContaining("Authentication required") })
})

test("an incident is read by the number of its reference, and one that does not exist is not found", async () => {
  const shown = await read(incident, {
    "https://incident.test/v2/incidents/7": {
      status: 200,
      body: {
        incident: {
          id: "01FDAG4SAP5TYPT98WGR2N7W91",
          reference: "INC-7",
          name: "Checkout is down",
          permalink: "https://app.incident.io/lovable/incidents/7",
          incident_status: { name: "Investigating", category: "live" },
          severity: { name: "Major", rank: 2 },
        },
      },
    },
  })

  const missing = await read(incident, { "https://incident.test/v2/incidents/7": { status: 404, body: {} } })

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
