import { Effect } from "effect"
import type { SessionFact } from "../protocol/session.ts"
import * as Index from "./index-store.ts"
import { SessionEntity, SessionEvent } from "./session.ts"
import { TaskEntity, TaskEvent } from "./task.ts"

/** The task a session starts when it is a root or a fork. */
const taskIdOf = (session: string) => `tsk_${session.replace(/^ses_/, "")}`

/**
 * Applies one fact about an OpenCode session to the tasks.
 *
 * Applying the same fact twice changes nothing, so the gateway can resend after a reconnect.
 */
export const apply = (db: D1Database, fact: SessionFact) =>
  Effect.gen(function* () {
    const sessions = yield* SessionEntity.client
    const tasks = yield* TaskEntity.client
    const send = (task: string, event: typeof TaskEvent.Type) =>
      tasks(task)
        .Send({ event })
        .pipe(Effect.tap((state) => Index.put(db, task, state)))
    const taskOf = (session: string) =>
      sessions(session)
        .GetState()
        .pipe(Effect.map((state) => (state._tag === "Bound" ? state.task : null)))

    switch (fact._tag) {
      case "Opened": {
        let task = yield* taskOf(fact.session)
        if (task === null) {
          if (fact.origin._tag === "Subagent") {
            task = yield* taskOf(fact.origin.of)
            if (task === null) return
          } else {
            task = taskIdOf(fact.session)
            const parent = fact.origin._tag === "Fork" ? yield* taskOf(fact.origin.of) : null
            yield* send(task, TaskEvent.Created({ title: fact.title ?? "Untitled", parent, session: fact.session }))
          }
          yield* sessions(fact.session).Send({ event: SessionEvent.Bound({ task }) })
        }
        if (fact.origin._tag === "Subagent") return
        // A snapshot repeats what the task already holds. Send only what differs, so the journal does not grow.
        const state = yield* tasks(task).GetState()
        if (state._tag === "Unborn") return
        if (fact.title !== null && fact.title !== state.title) {
          yield* send(task, TaskEvent.Renamed({ title: fact.title }))
        }
        const running = state._tag === "Active" && state.running.includes(fact.session)
        if (fact.running !== running) {
          yield* send(
            task,
            fact.running
              ? TaskEvent.SessionStarted({ session: fact.session })
              : TaskEvent.SessionIdle({ session: fact.session }),
          )
        }
        return
      }
      case "Started":
      case "Idle":
      case "Renamed": {
        const task = yield* taskOf(fact.session)
        if (task === null) return
        yield* send(
          task,
          fact._tag === "Started"
            ? TaskEvent.SessionStarted({ session: fact.session })
            : fact._tag === "Idle"
              ? TaskEvent.SessionIdle({ session: fact.session })
              : TaskEvent.Renamed({ title: fact.title }),
        )
      }
    }
  })
