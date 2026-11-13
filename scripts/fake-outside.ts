// A stand-in for the systems outside Ratchet, for running it end to end without touching a real session,
// issue or incident.
//
//   bun scripts/fake-outside.ts [port]
//
// It serves the part of OpenCode's API that the gateway uses, with two sessions to start with, and keeps what
// the gateway does to them. It also answers for Linear, under /linear/graphql, and for incident.io, under
// /incident. These routes of its own drive and inspect it:
//
//   POST /_emit     {"type": "session.execution.started", "data": {"sessionID": "ses_smokea"}}
//   POST /_session  {"id": "ses_new", "title": "A new session"}
//   POST /_issue    {"identifier": "DX-1", "title": "…", "state": {"name": "Done", "type": "completed"},
//                    "assignee": null, "comments": [{"id": "c1", "author": "jifeng"}]}
//   POST /_incident {"number": 7, "name": "…", "status": {"name": "Closed", "category": "closed"}, "severity": "Major"}
//   GET  /_state    the sessions, and the messages and prompts they were sent
import { Schema } from "effect"

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

const IssueQuery = Schema.Struct({ variables: Schema.Struct({ id: Schema.String }) })

const issues = new Map<string, typeof Issue.Type>()
const incidents = new Map<number, typeof Incident.Type>()

const readIssue = Schema.decodeUnknownPromise(Issue)
const readIncident = Schema.decodeUnknownPromise(Incident)
const readIssueQuery = Schema.decodeUnknownPromise(IssueQuery)
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

    if (url.pathname === "/linear/graphql") {
      const viewer = { id: "u-me", displayName: "me" }
      const issue = issues.get((await readIssueQuery(await request.json())).variables.id)

      if (issue === undefined) {
        return Response.json({ errors: [{ message: "Entity not found: Issue" }], data: { viewer, issue: null } })
      }

      return Response.json({
        data: {
          viewer,
          issue: {
            identifier: issue.identifier,
            title: issue.title,
            url: `https://linear.app/scratch/issue/${issue.identifier}`,
            state: issue.state,
            assignee: issue.assignee === null ? null : { id: `u-${issue.assignee}`, displayName: issue.assignee },
            comments: { nodes: issue.comments.map(({ id, author }) => ({ id, user: { displayName: author } })) },
          },
        },
      })
    }

    if (url.pathname.startsWith("/incident/v2/incidents/")) {
      const incident = incidents.get(Number(url.pathname.split("/").at(-1)))

      if (incident === undefined) return new Response("not found\n", { status: 404 })

      return Response.json({
        incident: {
          name: incident.name,
          permalink: `https://app.incident.io/scratch/incidents/${incident.number}`,
          incident_status: incident.status,
          severity: incident.severity === null ? null : { name: incident.severity },
        },
      })
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
