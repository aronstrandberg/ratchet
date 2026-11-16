import { DurableObject } from "cloudflare:workers"
import { Effect, Result } from "effect"
import type { Env } from "../env.ts"
import * as ResourcePoll from "./resource-poll.ts"
import { runtime } from "./runtime.ts"

const interval = 60_000

/** A pull request that the webhook proxy covers is read on every round of this many, in case a frame was missed. */
const sparse = 3

/** How the reading of watched resources is doing. */
export interface PollerStatus {
  readonly polls: number
  readonly watched: number
  /** Resources the last round could not read or report. */
  readonly failed: number
  readonly lastError: string | null
}

/**
 * Reads every resource the hub watches once a minute. A pull request that the webhook proxy covers is read
 * on every third round only: the proxy tells the gateway when it changes, except for a commit status, which
 * names no pull request.
 *
 * The class keeps the name it had when it read pull requests only, because a Durable Object's stored alarm
 * belongs to its class name. An alarm drives it, so it survives a restart.
 */
export class GitHubPoller extends DurableObject<Env> {
  #status: PollerStatus = { polls: 0, watched: 0, failed: 0, lastError: null }

  /** Arms the next round if none is armed, and reports the last one. */
  async ensure(): Promise<PollerStatus> {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + interval)

    return this.#status
  }

  /** Runs one round and arms the next. */
  override async alarm(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + interval)
    const polls = this.#status.polls + 1
    const gateway = runtime(this.env)

    if (Result.isFailure(gateway)) {
      this.#status = { ...this.#status, polls, lastError: gateway.failure.message }

      return
    }

    // The listening starts again here after a restart, and a round that cannot ask it reads everything.
    const covered = await this.env.WEBHOOK_STREAM.getByName("default")
      .ensure()
      .then((listening) => listening.covered)
      .catch(() => [])

    const heard = new Set(polls % sparse === 0 ? [] : covered)
    const round = await gateway.success.runPromise(Effect.result(ResourcePoll.round(heard)))
    this.#status = Result.isSuccess(round)
      ? { polls, watched: round.success.watched, failed: round.success.failed, lastError: null }
      : { ...this.#status, polls, lastError: String(round.failure).slice(0, 500) }
  }
}
