import type { Env } from "./env.ts"
import * as Mcp from "./hub/mcp.ts"

export {
  ClusterDurableQueue,
  ClusterEntity,
  ClusterSingleton,
  ClusterWorkflow,
} from "@effect/platform-cloudflare/CloudflareDurableObjects"
export { Gateway } from "./gateway/entrypoint.ts"
export { OpenCodeStream } from "./gateway/opencode-stream.ts"
export { Hub } from "./hub/entrypoint.ts"

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url)
    switch (pathname) {
      case "/tree":
        return Response.json(await env.HUB.tree())
      case "/mcp":
        return Mcp.handle(env, request)
      case "/gateway/opencode":
        return Response.json(await env.GATEWAY.watchOpenCode())
      default:
        return new Response("not found\n", { status: 404 })
    }
  },
}
