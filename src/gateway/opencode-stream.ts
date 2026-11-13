import { DurableObject } from "cloudflare:workers"
import { Effect, Ref, Result } from "effect"
import type { Env } from "../env.ts"
import { runtime } from "./runtime.ts"
import * as SessionSync from "./session-sync.ts"

const watchdog = 30_000

/**
 * Holds the gateway's one connection to OpenCode's event stream.
 *
 * The connection lives in memory, so an alarm checks on it: after an eviction or a restart the next alarm
 * starts it again.
 */
export class OpenCodeStream extends DurableObject<Env> {
  #loop: Promise<void> | undefined
  readonly #status = Effect.runSync(Ref.make(SessionSync.idle))

  /** Starts the connection if it is not running, arms the watchdog, and reports the connection. */
  async ensure(): Promise<SessionSync.Status> {
    await this.ctx.storage.setAlarm(Date.now() + watchdog)
    const gateway = runtime(this.env)

    if (Result.isFailure(gateway)) return { ...SessionSync.idle, lastError: gateway.failure.message }

    if (this.#loop === undefined) {
      this.#loop = gateway.success.runPromise(SessionSync.run(this.#status)).finally(() => {
        this.#loop = undefined
      })
      this.ctx.waitUntil(this.#loop)
    }

    return Effect.runSync(Ref.get(this.#status))
  }

  /** Checks on the connection. */
  override async alarm(): Promise<void> {
    await this.ensure()
  }
}
