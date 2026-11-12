import { WorkerEntrypoint } from "cloudflare:workers"
import { Effect } from "effect"
import type { Env } from "../env.ts"
import * as OpenCode from "./opencode.ts"
import type { StreamStatus } from "./opencode-stream.ts"

/** The gateway's interface to the hub and to the Worker's routes. */
export class Gateway extends WorkerEntrypoint<Env> {
  get #opencode(): OpenCode.Config {
    return { url: this.env.OPENCODE_URL, password: this.env.OPENCODE_PASSWORD }
  }

  /** Makes sure the gateway listens to OpenCode, and reports the connection. */
  async watchOpenCode(): Promise<StreamStatus> {
    return this.env.OPENCODE_STREAM.getByName("default").ensure()
  }

  /** Writes a session's current task into the session's metadata. */
  async recordTask(session: string, task: string): Promise<void> {
    const config = this.#opencode
    await Effect.runPromise(
      Effect.flatMap(OpenCode.read(config, session), (info) => OpenCode.recordTask(config, info, task)),
    )
  }

  /** Forks a session, names the fork and prompts it. Returns the fork's session ID. */
  async forkSession(session: string, title: string, prompt: string): Promise<string> {
    return Effect.runPromise(OpenCode.fork(this.#opencode, session, title, prompt))
  }
}
