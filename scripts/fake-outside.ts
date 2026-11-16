// A stand-in for the systems outside Ratchet, for running it end to end without touching a real session,
// issue or incident.
//
//   bun scripts/fake-outside.ts [port]
//
// It serves the part of OpenCode's API that the gateway uses, with two sessions to start with, and keeps what
// the gateway does to them. It also answers for the MCP servers of Linear, under /linear/mcp, of incident.io,
// under /incident/mcp, and of Buildkite, under /buildkite/mcp, behind a sign-in that it approves without
// asking. These routes of its own drive and inspect it:
//
//   POST /_emit     {"type": "session.execution.started", "data": {"sessionID": "ses_smokea"}}
//   POST /_session  {"id": "ses_new", "title": "A new session"}
//   POST /_issue    {"identifier": "DX-1", "title": "…", "state": {"name": "Done", "type": "completed"},
//                    "assignee": null, "comments": [{"id": "c1", "author": "jifeng"}]}
//   POST /_incident {"number": 7, "name": "…", "status": {"name": "Closed", "category": "closed"}, "severity": "Major"}
//   POST /_build    {"commit": "<40 hex>", "pipeline": "bazel", "number": 1, "state": "failed",
//                    "failedJobs": ["test"]}   optional: "branch" (main), "source" (webhook), "message"
//                   GitHub is the real one, so the commit is a merge commit there, or one that followed it.
//   POST /_expire   withdraws every access token, so that the gateway has to renew
//   POST /_revoke   ends every sign-in, so that someone has to sign in again
//   GET  /_state    the sessions, and the messages and prompts they were sent
import { Schema } from "effect"
import * as FakeMcp from "../src/gateway/fake-mcp.ts"
import * as FakeSignIn from "../src/gateway/fake-sign-in.ts"

const Session = Schema.Struct({
  id: Schema.String,
  title: Schema.optional(Schema.String),
  parentID: Schema.optional(Schema.String),
  fork: Schema.optional(Schema.Struct({ sessionID: Schema.String })),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
  time: Schema.Struct({ created: Schema.Number, updated: Schema.Number }),
})

type Session = { -readonly [Key in keyof typeof Session.Type]: (typeof Session.Type)[Key] }

const NewSession = Schema.Struct({ id: Schema.String, title: Schema.optional(Schema.String) })

const Patch = Schema.Struct({
  title: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
})

const Message = Schema.Struct({ id: Schema.optional(Schema.String), text: Schema.String })
const Emitted = Schema.Struct({ type: Schema.String, data: Schema.Record(Schema.String, Schema.Json) })

const Issue = Schema.Struct({
  identifier: Schema.String,
  title: Schema.String,
  state: Schema.Struct({ name: Schema.String, type: Schema.String }),
  assignee: Schema.NullOr(Schema.String),
  comments: Schema.Array(Schema.Struct({ id: Schema.String, author: Schema.String })),
})

const Incident = Schema.Struct({
  number: Schema.Number,
  name: Schema.String,
  status: Schema.Struct({ name: Schema.String, category: Schema.String }),
  severity: Schema.NullOr(Schema.String),
})

const Build = Schema.Struct({
  commit: Schema.String,
  pipeline: Schema.String,
  number: Schema.Number,
  state: Schema.String,
  branch: Schema.optional(Schema.String),
  /** What started the build: `webhook` for a push, `trigger_job` for another build, `schedule`. */
  source: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
  failedJobs: Schema.optional(Schema.Array(Schema.String)),
})

/** The builds, by pipeline and number, each with when it was first put here. */
const builds = new Map<string, typeof Build.Type & { readonly createdAt: string }>()
const readBuild = Schema.decodeUnknownPromise(Build)

const issues = new Map<string, typeof Issue.Type>()
const incidents = new Map<number, typeof Incident.Type>()

const readIssue = Schema.decodeUnknownPromise(Issue)
const readIncident = Schema.decodeUnknownPromise(Incident)
const readNewSession = Schema.decodeUnknownPromise(NewSession)
const readPatch = Schema.decodeUnknownPromise(Patch)
const readMessage = Schema.decodeUnknownPromise(Message)
const readEmitted = Schema.decodeUnknownPromise(Emitted)

const sessions = new Map<string, Session>()
const messages: Array<{ session: string; kind: "synthetic" | "prompt"; id: string; text: string }> = []
const listeners = new Set<ReadableStreamDefaultController<Uint8Array>>()
const encoder = new TextEncoder()
let clock = 1_000

const add = (id: string, title: string | undefined, fork?: string): Session => {
  clock += 1

  const session: Session = { id, time: { created: clock, updated: clock } }

  if (title !== undefined) session.title = title

  if (fork !== undefined) session.fork = { sessionID: fork }

  sessions.set(id, session)

  return session
}

const emit = (event: typeof Emitted.Type) => {
  const frame = encoder.encode(`data: ${JSON.stringify(event)}\n\n`)

  for (const listener of listeners) listener.enqueue(frame)
}

const missing = () => Response.json({ message: "no such session" }, { status: 404 })

add("ses_smokea", "Speed up the build")

add("ses_smokeb", "Fix the flaky test")

const port = Number(process.argv[2] ?? 4999)
const signIn = FakeSignIn.make(`http://127.0.0.1:${port}`)

const linear = FakeMcp.make(
  {
    get_issue: (input) => {
      const issue = issues.get(String(input["id"]))

      if (issue === undefined) return { problem: "Could not find referenced Issue." }

      return {
        value: {
          id: issue.identifier,
          title: issue.title,
          url: `https://linear.app/scratch/issue/${issue.identifier}`,
          status: issue.state.name,
          statusType: issue.state.type,
          assignee: issue.assignee,
          assigneeId: issue.assignee === null ? null : `u-${issue.assignee}`,
        },
      }
    },
    // Linear lists the newest comment first.
    list_comments: (input) => ({
      value: {
        comments: (issues.get(String(input["issueId"]))?.comments ?? [])
          .map(({ id, author }) => ({ id, body: "…", author: { id: `u-${author}`, name: author } }))
          .toReversed(),
      },
    }),
    get_user: () => ({ value: { id: "u-me", name: "me" } }),
  },
  { streamed: true },
)

const buildOf = (input: Readonly<Record<string, Schema.Json>>) =>
  builds.get(`${String(input["pipeline_slug"])}/${String(input["build_number"])}`)

const buildkite = FakeMcp.make(
  {
    list_builds: (input) => ({
      value: {
        items: [...builds.values()].flatMap((build) =>
          build.commit === input["commit"]
            ? [
                {
                  id: `${build.pipeline}-${build.number}`,
                  branch: build.branch ?? "main",
                  commit: build.commit,
                  state: build.state,
                  number: build.number,
                  message: build.message ?? "A change (#1)",
                  created_at: build.createdAt,
                  web_url: `https://buildkite.com/scratch/${build.pipeline}/builds/${build.number}`,
                },
              ]
            : [],
        ),
      },
    }),
    get_build: (input) => ({ value: { source: buildOf(input)?.source ?? "webhook" } }),
    list_jobs: (input) => ({
      value: { items: (buildOf(input)?.failedJobs ?? []).map((name) => ({ name, step_key: name, state: "failed" })) },
    }),
  },
  { streamed: false },
)

const incidentIo = FakeMcp.make(
  {
    incident_show: (input) => {
      const incident = incidents.get(Number(String(input["id"]).replace(/^INC-/, "")))

      if (incident === undefined) return { problem: "incident not found" }

      return {
        value: {
          name: incident.name,
          permalink: `https://app.incident.io/scratch/incidents/${incident.number}`,
          status: incident.status,
          severity: incident.severity === null ? null : { name: incident.severity },
        },
      }
    },
  },
  { streamed: false },
)

Bun.serve({
  port,
  hostname: "127.0.0.1",
  idleTimeout: 0,
  fetch: async (request) => {
    const url = new URL(request.url)
    const [, api, resource, id, action] = url.pathname.split("/")

    if (url.pathname === "/_state") return Response.json({ sessions: [...sessions.values()], messages })

    if (url.pathname === "/_issue") {
      const issue = await readIssue(await request.json())
      issues.set(issue.identifier, issue)

      return Response.json({ issues: issues.size })
    }

    if (url.pathname === "/_incident") {
      const incident = await readIncident(await request.json())
      incidents.set(incident.number, incident)

      return Response.json({ incidents: incidents.size })
    }

    const signedIn = await signIn.fetch(request)

    if (signedIn !== null) return signedIn

    const system = { "/linear/mcp": linear, "/incident/mcp": incidentIo, "/buildkite/mcp": buildkite }[url.pathname]

    if (system !== undefined) {
      if (!signIn.accepts(request) || request.method !== "POST") return signIn.refusal(url.pathname)

      return system.fetch(request)
    }

    if (url.pathname === "/_build") {
      const build = await readBuild(await request.json())
      const key = `${build.pipeline}/${build.number}`
      builds.set(key, { ...build, createdAt: builds.get(key)?.createdAt ?? new Date().toISOString() })

      return Response.json({ builds: builds.size })
    }

    if (url.pathname === "/_expire") {
      signIn.expire()

      return Response.json({ expired: true })
    }

    if (url.pathname === "/_revoke") {
      signIn.revoke()

      return Response.json({ revoked: true })
    }

    if (url.pathname === "/_emit") {
      emit(await readEmitted(await request.json()))

      return Response.json({ listeners: listeners.size })
    }

    if (url.pathname === "/_session") {
      const created = await readNewSession(await request.json())
      add(created.id, created.title)
      emit({ type: "session.created", data: { sessionID: created.id } })

      return Response.json({ id: created.id })
    }

    if (api !== "api") return new Response("not found\n", { status: 404 })

    if (resource === "event") {
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined

      return new Response(
        new ReadableStream<Uint8Array>({
          start: (started) => {
            controller = started
            listeners.add(started)
          },
          cancel: () => {
            if (controller !== undefined) listeners.delete(controller)
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    }

    if (resource !== "session") return new Response("not found\n", { status: 404 })

    if (id === undefined) return Response.json({ data: [...sessions.values()].sort((a, b) => a.time.created - b.time.created) })

    if (id === "active") return Response.json({ data: {} })
    const session = sessions.get(id)

    if (session === undefined) return missing()

    if (action === undefined && request.method === "GET") return Response.json({ data: session })

    if (action === undefined && request.method === "PATCH") {
      const patch = await readPatch(await request.json())
      clock += 1
      session.time = { ...session.time, updated: clock }

      if (patch.title !== undefined) session.title = patch.title

      if (patch.metadata !== undefined) session.metadata = patch.metadata

      return Response.json({ data: session })
    }

    if (action === "form" || action === "permission") return Response.json({ data: [] })

    if (action === "fork") {
      const fork = add(`ses_fork${sessions.size}`, session.title, id)
      emit({ type: "session.forked", data: { sessionID: fork.id } })

      return Response.json({ data: fork })
    }

    if (action === "synthetic" || action === "prompt") {
      const message = await readMessage(await request.json())
      const messageId = message.id ?? `msg_fake${messages.length}`

      // A message whose ID the session already holds is admitted once, as OpenCode does it.
      if (!messages.some((held) => held.id === messageId)) {
        messages.push({ session: id, kind: action, id: messageId, text: message.text })
      }

      return Response.json({ data: { id: messageId } })
    }

    return new Response("not found\n", { status: 404 })
  },
})

console.log(`the stand-in for the outside is on http://127.0.0.1:${port}`)
