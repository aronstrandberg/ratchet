import { DurableObject } from "cloudflare:workers"
import { Effect, Fiber, Schedule, Stream } from "effect"
import type { Env } from "../env.ts"
import * as OpenCode from "./opencode.ts"

const watchdog = 30_000

export interface StreamStatus {
  readonly connected: boolean
  readonly connects: number
  readonly facts: number
  readonly lastError: string | null
}

/**
 * Holds the gateway's one connection to OpenCode's event stream and sends what it hears to the hub.
 *
 * The connection lives in memory, so an alarm checks on it: after an eviction or a restart the next alarm
 * reconnects. Each connect starts with a snapshot of every session, because the stream does not replay.
 */
export class OpenCodeStream extends DurableObject<Env> {
  #loop: Promise<void> | undefined
  #status: StreamStatus = { connected: false, connects: 0, facts: 0, lastError: null }

  /** Starts the connection if it is not running, and arms the watchdog. */
  async ensure(): Promise<StreamStatus> {
    await this.ctx.storage.setAlarm(Date.now() + watchdog)
    if (this.#loop === undefined) {
      this.#loop = Effect.runPromise(this.#run()).finally(() => {
        this.#loop = undefined
      })
      this.ctx.waitUntil(this.#loop)
    }
    return this.#status
  }

  override async alarm(): Promise<void> {
    await this.ensure()
  }

  #run(): Effect.Effect<void> {
    const config: OpenCode.Config = { url: this.env.OPENCODE_URL, password: this.env.OPENCODE_PASSWORD }
    const hub = this.env.HUB
    const send = (facts: ReadonlyArray<unknown>) =>
      Effect.tryPromise(() => hub.sessionFacts(facts)).pipe(
        Effect.tap((count) =>
          Effect.sync(() => {
            this.#status = { ...this.#status, facts: this.#status.facts + count }
          }),
        ),
      )
    const connected = Effect.sync(() => {
      this.#status = { ...this.#status, connected: true, connects: this.#status.connects + 1, lastError: null }
    })
    const once = Effect.gen(function* () {
      yield* connected
      // Listen before the snapshot, so nothing that happens during it is lost.
      const live = OpenCode.facts(config).pipe(
        Stream.runForEach((fact) => send([fact])),
        Effect.forkChild,
      )
      const fiber = yield* live
      yield* Effect.flatMap(OpenCode.snapshot(config), send)
      yield* Fiber.join(fiber)
    })
    return once.pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          this.#status = { ...this.#status, lastError: String(cause).slice(0, 500) }
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          this.#status = { ...this.#status, connected: false }
        }),
      ),
      Effect.repeat(Schedule.spaced("5 seconds")),
      Effect.asVoid,
    )
  }
}
