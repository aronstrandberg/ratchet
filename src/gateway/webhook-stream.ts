import { DurableObject } from "cloudflare:workers"
import { Effect, Ref, Result } from "effect"
import * as Config from "../config.ts"
import type { Env } from "../env.ts"
import * as LiveReads from "./live-reads.ts"
import { runtime } from "./runtime.ts"

const watchdog = 30_000

/**
 * Holds the gateway's connections to the webhook proxy's stream of GitHub events.
 *
 * The connections live in memory, so an alarm checks on them: after an eviction or a restart the next alarm
 * starts them again.
 */
export class WebhookStream extends DurableObject<Env> {
  #loop: Promise<void> | undefined
  readonly #status = Effect.runSync(Ref.make(LiveReads.idle))

  /** Starts the listening if it is not running, arms the watchdog, and reports how the listening is doing. */
  async ensure(): Promise<LiveReads.Status> {
    await this.ctx.storage.setAlarm(Date.now() + watchdog)
    const gateway = runtime(this.env)
    const config = Config.gateway(this.env)

    if (Result.isFailure(gateway)) return { ...LiveReads.idle, problem: gateway.failure.message }

    if (Result.isFailure(config)) return { ...LiveReads.idle, problem: config.failure.message }

    if (this.#loop === undefined) {
      const listening = LiveReads.run(this.#status, {
        repos: config.success.proxy.repos,
        prompt: "5 seconds",
        relaxed: "45 seconds",
        recheck: "30 seconds",
      })

      this.#loop = gateway.success.runPromise(listening).finally(() => {
        this.#loop = undefined
      })
      this.ctx.waitUntil(this.#loop)
    }

    return Effect.runSync(Ref.get(this.#status))
  }

  /** Checks on the listening. */
  override async alarm(): Promise<void> {
    await this.ensure()
  }
}
