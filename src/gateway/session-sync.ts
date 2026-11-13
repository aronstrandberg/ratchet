import { Effect, Fiber, Ref, Schedule, Stream } from "effect"
import type { TaskId } from "../protocol/ids.ts"
import type { SessionFact } from "../protocol/session.ts"
import * as HubReports from "./hub-reports.ts"
import * as OpenCode from "./opencode.ts"

/** How the gateway's connection to OpenCode's sessions is doing. */
export interface Status {
  readonly connected: boolean
  readonly connects: number
  /** Facts sent to the hub since the connection's holder woke. */
  readonly facts: number
  /** Sessions whose metadata got their task ID written into it. */
  readonly recorded: number
  readonly lastError: string | null
}

/** The status of a connection that has not started. */
export const idle: Status = { connected: false, connects: 0, facts: 0, recorded: 0, lastError: null }

/**
 * Keeps the hub in step with OpenCode's sessions for as long as it runs, and reconnects when the event stream
 * ends.
 *
 * Each connect listens first and takes a snapshot of every session second, because the stream does not replay
 * and nothing that happens during the snapshot may be lost. The hub's answer names the task of each session a
 * fact opened, and that task is written into the session's metadata.
 */
export const run = (status: Ref.Ref<Status>): Effect.Effect<void, never, OpenCode.Service | HubReports.Service> =>
  Effect.gen(function* () {
    const opencode = yield* OpenCode.Service
    const hub = yield* HubReports.Service

    const send = (facts: ReadonlyArray<SessionFact>) =>
      hub.sessionFacts(facts).pipe(Effect.tap(() => Ref.update(status, (s) => ({ ...s, facts: s.facts + facts.length }))))

    const record = (info: OpenCode.SessionInfo, task: TaskId) =>
      opencode.recordTask(info, task).pipe(
        Effect.tap((outcome) =>
          outcome === "written" ? Ref.update(status, (s) => ({ ...s, recorded: s.recorded + 1 })) : Effect.void,
        ),
      )

    const live = opencode.facts.pipe(
      Stream.runForEach((fact) =>
        Effect.gen(function* () {
          for (const binding of yield* send([fact])) {
            yield* record(yield* opencode.session(binding.session), binding.task)
          }
        }),
      ),
    )

    const converge = Effect.gen(function* () {
      const snapshot = yield* opencode.snapshot
      const tasks = new Map((yield* send(snapshot.facts)).map((binding) => [binding.session, binding.task]))
      // Least recently updated first: a write moves a session's `updated` time, and this keeps their order.
      const byUpdated = [...snapshot.sessions].sort((a, b) => a.time.updated - b.time.updated)

      for (const info of byUpdated) {
        const task = tasks.get(info.id)

        if (task !== undefined) yield* record(info, task)
      }
    }).pipe(Effect.withSpan("SessionSync.converge"))

    const once = Effect.gen(function* () {
      yield* Ref.update(status, (s) => ({ ...s, connected: true, connects: s.connects + 1, lastError: null }))
      const listening = yield* Effect.forkChild(live)
      yield* converge
      yield* Fiber.join(listening)
    })

    yield* once.pipe(
      Effect.catchCause((cause) => Ref.update(status, (s) => ({ ...s, lastError: String(cause).slice(0, 500) }))),
      Effect.ensuring(Ref.update(status, (s) => ({ ...s, connected: false }))),
      Effect.repeat(Schedule.spaced("5 seconds")),
    )
  })
