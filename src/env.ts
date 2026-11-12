import type { Gateway } from "./gateway/entrypoint.ts"
import type { GitHubPoller } from "./gateway/github-poller.ts"
import type { OpenCodeStream } from "./gateway/opencode-stream.ts"
import type { Hub } from "./hub/entrypoint.ts"

export interface Env {
  readonly CLUSTER_ENTITY: DurableObjectNamespace
  readonly CLUSTER_WORKFLOW: DurableObjectNamespace
  readonly CLUSTER_QUEUE: DurableObjectNamespace
  readonly CLUSTER_SINGLETON: DurableObjectNamespace
  readonly OPENCODE_STREAM: DurableObjectNamespace<OpenCodeStream>
  readonly GITHUB_POLLER: DurableObjectNamespace<GitHubPoller>
  readonly HUB: Service<Hub>
  readonly GATEWAY: Service<Gateway>
  readonly INDEX: D1Database
  readonly OPENCODE_URL: string
  readonly OPENCODE_PASSWORD: string
  readonly GITHUB_TOKEN: string
  /** Which sessions Ratchet may wake: `*` for all, or session IDs separated by commas. Empty wakes none. */
  readonly WAKE_SESSIONS?: string
  /** Base URL of the OTLP/HTTP collector. Empty or absent turns tracing off. */
  readonly OTLP_URL?: string
}
