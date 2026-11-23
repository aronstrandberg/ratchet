import type { Env } from "./env.ts"
import { Result, Schema } from "effect"
import { Answer } from "./protocol/decision.ts"
import * as Mcp from "./hub/mcp.ts"
import { buildRoute } from "./gateway/build-route.ts"

export {
  ClusterDurableQueue,
  ClusterEntity,
  ClusterSingleton,
  ClusterWorkflow,
} from "@effect/platform-cloudflare/CloudflareDurableObjects"

export { Gateway } from "./gateway/entrypoint.ts"

export { GitHubPoller } from "./gateway/github-poller.ts"

export { OpenCodeStream } from "./gateway/opencode-stream.ts"

export { SignIn } from "./gateway/sign-in.ts"

export { WebhookStream } from "./gateway/webhook-stream.ts"

export { Hub } from "./hub/entrypoint.ts"

const AnswerBody = Schema.Struct({
  option: Schema.optional(Schema.String),
  text: Schema.optional(Answer.cases.Wrote.fields.text),
  note: Schema.optional(Schema.String),
})

const decodeAnswerBody = Schema.decodeUnknownResult(Schema.fromJsonString(AnswerBody))

/** The status a failure of the hub's answer stands for, by the name it keeps across the binding. */
const answerStatus = (name: string): number | null => {
  switch (name) {
    case "UnknownDecision":
      return 404
    case "DecisionClosed":
      return 409
    case "UnknownOption":
      return 400
    default:
      return null
  }
}

const route = async (request: Request, env: Env): Promise<Response> => {
  switch (new URL(request.url).pathname) {
    case "/inbox":
      return Response.json(await env.HUB.inbox())
    case "/tree":
      return Response.json(await env.HUB.tree())
    case "/mcp":
      return Mcp.handle(env, request)
    case "/resources":
      return Response.json(await env.HUB.resources())
    case "/prs":
      return Response.json((await env.HUB.resources()).filter((row) => row.kind === "pull_request"))
    case "/builds":
      return buildRoute(request, env.GATEWAY)
    case "/gateway/opencode":
      return Response.json(await env.GATEWAY.watchOpenCode())
    case "/gateway/webhooks":
      return Response.json(await env.GATEWAY.watchWebhooks())
    case "/gateway/sign-ins":
      return Response.json(await env.GATEWAY.signIns())
    default:
      return new URL(request.url).pathname.startsWith("/decisions/") ? answer(request, env) : signIn(request, env)
  }
}

/**
 * `POST /decisions/<id>/answer`, as JSON or as a form: `option` with an option's label, or `text` with an answer
 * in my own words, and `note`.
 */
const answer = async (request: Request, env: Env): Promise<Response> => {
  const [, id] = /^\/decisions\/([^/]+)\/answer$/.exec(new URL(request.url).pathname) ?? []

  if (id === undefined || request.method !== "POST") return new Response("not found\n", { status: 404 })

  // JSON only: a page on another site can post a form here without asking, but not JSON.
  if (!(request.headers.get("content-type") ?? "").startsWith("application/json")) {
    return new Response("send the answer as application/json\n", { status: 415 })
  }

  const fields = decodeAnswerBody(await request.text())

  if (Result.isFailure(fields)) return new Response(`${fields.failure.message}\n`, { status: 400 })
  const { option = "", text = "", note = "" } = fields.success

  if (option.trim() === "" && text.trim() === "") {
    return new Response("give an option or an answer of your own\n", { status: 400 })
  }

  const given =
    option.trim() === ""
      ? Answer.cases.Wrote.make({ text: text.trim() })
      : Answer.cases.Chose.make({ option: option.trim() })

  try {
    await env.HUB.answer({ id, answer: Schema.encodeSync(Answer)(given), note: note.trim() })
  } catch (cause) {
    const status = cause instanceof Error ? answerStatus(cause.name) : null

    if (status === null) throw cause

    return Response.json({ error: cause instanceof Error ? cause.message : String(cause) }, { status })
  }

  return new Response(null, { status: 204 })
}

/** The two steps of a sign-in to one system: `/gateway/sign-ins/<system>/login` and `…/callback`. */
const signIn = async (request: Request, env: Env): Promise<Response> => {
  const url = new URL(request.url)
  const [, system, step] = /^\/gateway\/sign-ins\/([^/]+)\/(login|callback)$/.exec(url.pathname) ?? []

  if (system === undefined) return new Response("not found\n", { status: 404 })

  if (step === "login") return Response.json({ open: await env.GATEWAY.beginSignIn(system, url.origin) })

  await env.GATEWAY.completeSignIn(system, request.url)

  return new Response(`Ratchet is signed in to ${system}. You can close this page.\n`)
}

/**
 * The Worker's routes: the board's reads, the sessions' tools and the gateway's status.
 *
 * A route that fails answers 503 with the failure's message, which names no secret.
 */
/** Whether a request names this machine. A page whose name resolves here by a trick names its own host. */
const loopback = (request: Request) => /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(request.headers.get("host") ?? "")

export default {
  fetch: (request: Request, env: Env): Promise<Response> =>
    (loopback(request) ? route(request, env) : Promise.resolve(new Response("forbidden\n", { status: 403 }))).catch((cause: unknown) =>
      Response.json({ error: cause instanceof Error ? cause.message : String(cause) }, { status: 503 }),
    ),
}
