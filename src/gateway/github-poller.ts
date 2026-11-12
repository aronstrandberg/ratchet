import { DurableObject } from "cloudflare:workers"
import { Effect, Result } from "effect"
import type { Env } from "../env.ts"
import * as Telemetry from "../telemetry.ts"
import * as GitHub from "./github.ts"

const interval = 60_000

export interface PollerStatus {
  readonly polls: number
  readonly watched: number
  readonly lastError: string | null
}

/**
 * Reads every pull request the hub watches once a minute and hands each observation to the hub.
 *
 * It stands in for the webhook proxy stream. An alarm drives it, so it survives a restart.
 */
export class GitHubPoller extends DurableObject<Env> {
  #status: PollerStatus = { polls: 0, watched: 0, lastError: null }

  /** Arms the next poll if none is armed. */
  async ensure(): Promise<PollerStatus> {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + interval)

    return this.#status
  }

  override async alarm(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + interval)
    const env = this.env

    const poll = Effect.gen(function* () {
      const refs = yield* Effect.tryPromise(() => env.HUB.watchedPullRequests())

      for (const ref of refs) {
        const facts = yield* GitHub.readSettled(env.GITHUB_TOKEN, ref)
        yield* Effect.tryPromise(() => env.HUB.pullRequestFacts(facts))
      }

      // A wake-up that failed before gets another try.
      yield* Effect.tryPromise(() => env.HUB.deliverWakes())

      return refs.length
    }).pipe(Effect.withSpan("GitHubPoller.poll"), Effect.provide(Telemetry.layer(env, "ratchet-gateway")))

    const result = await Effect.runPromise(Effect.result(poll))
    this.#status =
      Result.isSuccess(result)
        ? { polls: this.#status.polls + 1, watched: result.success, lastError: null }
        : { ...this.#status, polls: this.#status.polls + 1, lastError: String(result.failure).slice(0, 500) }
  }
}
