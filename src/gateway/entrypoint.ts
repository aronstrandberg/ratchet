import { WorkerEntrypoint } from "cloudflare:workers"
import { Effect } from "effect"
import type { Env } from "../env.ts"
import type { PullRequestRef } from "../protocol/pull-request.ts"
import * as GitHub from "./github.ts"
import type { PollerStatus } from "./github-poller.ts"
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

  /** Reads a pull request now, hands it to the hub, and keeps the poller running. */
  async observePullRequest(ref: PullRequestRef): Promise<PollerStatus> {
    const facts = await Effect.runPromise(GitHub.readSettled(this.env.GITHUB_TOKEN, ref))
    await this.env.HUB.pullRequestFacts(facts)
    return this.env.GITHUB_POLLER.getByName("default").ensure()
  }

  /** Puts a message into a session and lets it run. */
  async wake(session: string, text: string): Promise<void> {
    await Effect.runPromise(OpenCode.wake(this.#opencode, session, text))
  }

  /** Forks a session, names the fork and prompts it. Returns the fork's session ID. */
  async forkSession(session: string, title: string, prompt: string): Promise<string> {
    return Effect.runPromise(OpenCode.fork(this.#opencode, session, title, prompt))
  }
}
