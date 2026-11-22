import type { Env } from "./env.ts"
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

const route = async (request: Request, env: Env): Promise<Response> => {
  switch (new URL(request.url).pathname) {
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
      return signIn(request, env)
  }
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
export default {
  fetch: (request: Request, env: Env): Promise<Response> =>
    route(request, env).catch((cause: unknown) =>
      Response.json({ error: cause instanceof Error ? cause.message : String(cause) }, { status: 503 }),
    ),
}
