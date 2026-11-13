import type { Settings } from "./config.ts"
import type { Gateway } from "./gateway/entrypoint.ts"
import type { GitHubPoller } from "./gateway/github-poller.ts"
import type { OpenCodeStream } from "./gateway/opencode-stream.ts"
import type { Hub } from "./hub/entrypoint.ts"

/** What the runtime hands the Worker: its bindings and its settings. Only composition roots read it. */
export interface Env extends Settings {
  readonly CLUSTER_ENTITY: DurableObjectNamespace
  readonly CLUSTER_WORKFLOW: DurableObjectNamespace
  readonly CLUSTER_QUEUE: DurableObjectNamespace
  readonly CLUSTER_SINGLETON: DurableObjectNamespace
  readonly OPENCODE_STREAM: DurableObjectNamespace<OpenCodeStream>
  readonly GITHUB_POLLER: DurableObjectNamespace<GitHubPoller>
  readonly HUB: Service<Hub>
  readonly GATEWAY: Service<Gateway>
  readonly INDEX: D1Database
}
