import { WorkerEntrypoint } from "cloudflare:workers"
import type { Env } from "../env.ts"
import type { StreamStatus } from "./opencode-stream.ts"

/** The gateway's interface to the hub and to the Worker's routes. */
export class Gateway extends WorkerEntrypoint<Env> {
  /** Makes sure the gateway listens to OpenCode, and reports the connection. */
  async watchOpenCode(): Promise<StreamStatus> {
    return this.env.OPENCODE_STREAM.getByName("default").ensure()
  }
}
