import type { Env } from "./env.ts"
import * as Mcp from "./hub/mcp.ts"

export {
  ClusterDurableQueue,
  ClusterEntity,
  ClusterSingleton,
  ClusterWorkflow,
} from "@effect/platform-cloudflare/CloudflareDurableObjects"

export { Gateway } from "./gateway/entrypoint.ts"

export { GitHubPoller } from "./gateway/github-poller.ts"

export { OpenCodeStream } from "./gateway/opencode-stream.ts"

export { ProxySignIn } from "./gateway/proxy-sign-in.ts"

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
    case "/gateway/opencode":
      return Response.json(await env.GATEWAY.watchOpenCode())
    case "/gateway/proxy":
      return Response.json({ signedIn: await env.GATEWAY.proxySignedIn() })
    case "/gateway/proxy/login":
      return Response.json({ open: await env.GATEWAY.proxyLogin(new URL(request.url).origin) })
    case "/gateway/proxy/callback":
      await env.GATEWAY.proxyCallback(request.url)

      return new Response("Ratchet is signed in to the webhook proxy. You can close this page.\n")
    default:
      return new Response("not found\n", { status: 404 })
  }
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
