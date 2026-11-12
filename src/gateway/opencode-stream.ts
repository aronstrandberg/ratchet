import { DurableObject } from "cloudflare:workers"
import { Effect, Fiber, Schedule, Stream } from "effect"
import type { Env } from "../env.ts"
import type { Binding, SessionFact } from "../protocol/session.ts"
import * as Telemetry from "../telemetry.ts"
import * as OpenCode from "./opencode.ts"

const watchdog = 30_000

export interface StreamStatus {
  readonly connected: boolean
  readonly connects: number
  /** Facts sent to the hub since this object woke. */
  readonly facts: number
  /** Sessions whose metadata this object wrote the task ID into. */
  readonly recorded: number
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
  #status: StreamStatus = { connected: false, connects: 0, facts: 0, recorded: 0, lastError: null }

  /** Starts the connection if it is not running, and arms the watchdog. */
  async ensure(): Promise<StreamStatus> {
    await this.ctx.storage.setAlarm(Date.now() + watchdog)
    if (this.#loop === undefined) {
      const run = this.#run().pipe(Effect.provide(Telemetry.layer(this.env, "ratchet-gateway")))
      this.#loop = Effect.runPromise(run).finally(() => {
        this.#loop = undefined
      })
      this.ctx.waitUntil(this.#loop)
    }
    return this.#status
  }

  override async alarm(): Promise<void> {
    await this.ensure()
  }

  #update(change: (status: StreamStatus) => StreamStatus): Effect.Effect<void> {
    return Effect.sync(() => {
      this.#status = change(this.#status)
    })
  }

  #run(): Effect.Effect<void> {
    const config: OpenCode.Config = { url: this.env.OPENCODE_URL, password: this.env.OPENCODE_PASSWORD }
    const hub = this.env.HUB
    const send = (facts: ReadonlyArray<SessionFact>): Effect.Effect<ReadonlyArray<Binding>, unknown> =>
      Effect.tryPromise(() => hub.sessionFacts(facts)).pipe(
        Effect.tap(() => this.#update((s) => ({ ...s, facts: s.facts + facts.length }))),
      )
    const record = (info: OpenCode.SessionInfo, task: string) =>
      OpenCode.recordTask(config, info, task).pipe(
        Effect.tap((wrote) => (wrote ? this.#update((s) => ({ ...s, recorded: s.recorded + 1 })) : Effect.void)),
      )

    const live = OpenCode.facts(config).pipe(
      Stream.runForEach((fact) =>
        Effect.gen(function* () {
          const bindings = yield* send([fact])
          for (const binding of bindings) {
            yield* record(yield* OpenCode.read(config, binding.session), binding.task)
          }
        }),
      ),
    )
    const converge = Effect.gen(function* () {
      const snapshot = yield* OpenCode.snapshot(config)
      const tasks = new Map((yield* send(snapshot.facts)).map((binding) => [binding.session, binding.task]))
      // Least recently updated first: a write moves a session's `updated` time, and this keeps their order.
      const byUpdated = [...snapshot.sessions].sort((a, b) => a.time.updated - b.time.updated)
      for (const info of byUpdated) {
        const task = tasks.get(info.id)
        if (task !== undefined) yield* record(info, task)
      }
    }).pipe(Effect.withSpan("OpenCodeStream.converge"))
    const connected = this.#update((s) => ({ ...s, connected: true, connects: s.connects + 1, lastError: null }))
    const once = Effect.gen(function* () {
      yield* connected
      // Listen before the snapshot, so nothing that happens during it is lost.
      const listening = yield* Effect.forkChild(live)
      yield* converge
      yield* Fiber.join(listening)
    })
    return once.pipe(
      Effect.catchCause((cause) => this.#update((s) => ({ ...s, lastError: String(cause).slice(0, 500) }))),
      Effect.ensuring(this.#update((s) => ({ ...s, connected: false }))),
      Effect.repeat(Schedule.spaced("5 seconds")),
      Effect.asVoid,
    )
  }
}
