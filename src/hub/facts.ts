import { Effect } from "effect"
import type { Binding, SessionFact } from "../protocol/session.ts"
import * as Index from "./index-store.ts"
import { SessionEntity, SessionEvent } from "./session.ts"
import { TaskEntity, TaskEvent, type TaskState } from "./task.ts"

/** The task a main session starts when the hub first sees it. */
const taskIdOf = (session: string) => `tsk_${session.replace(/^ses_/, "")}`

const sameSet = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
  a.length === b.length && a.every((item) => b.includes(item))

/** Whether an `Opened` fact says anything the task does not already hold about that session. */
const differs = (state: Exclude<TaskState, { _tag: "Unborn" }>, fact: Extract<SessionFact, { _tag: "Opened" }>) =>
  state.running.includes(fact.session) !== fact.running ||
  !sameSet(
    state.subagents.filter((s) => s.of === fact.session).map((s) => s.session),
    fact.subagents,
  ) ||
  !sameSet(
    state.questions.filter((q) => q.session === fact.session).map((q) => q.id),
    fact.questions.map((q) => q.id),
  )

/**
 * Applies one fact about an OpenCode session to the tasks, and returns the session's task when the fact opens it.
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
    const toTaskOf = (session: string, event: typeof TaskEvent.Type) =>
      Effect.flatMap(taskOf(session), (task) => (task === null ? Effect.void : Effect.asVoid(send(task, event))))

    switch (fact._tag) {
      case "Opened": {
        let task = yield* taskOf(fact.session)
        if (task === null) {
          task = taskIdOf(fact.session)
          const parent = fact.origin._tag === "Fork" ? yield* taskOf(fact.origin.of) : null
          yield* send(task, TaskEvent.Created({ title: fact.title ?? "Untitled", parent, session: fact.session }))
          yield* sessions(fact.session).Send({ event: SessionEvent.Bound({ task }) })
        }
        const binding: Binding = { session: fact.session, task }
        // A snapshot repeats what the task already holds. Send only what differs, so the journal does not grow.
        const state = yield* tasks(task).GetState()
        if (state._tag === "Unborn") return binding
        if (fact.title !== null && fact.title !== state.title) {
          yield* send(task, TaskEvent.Renamed({ title: fact.title }))
        }
        if (differs(state, fact)) {
          yield* send(
            task,
            TaskEvent.Observed({
              session: fact.session,
              running: fact.running,
              subagents: fact.subagents,
              questions: fact.questions,
            }),
          )
        }
        return binding
      }
      case "Started":
        yield* toTaskOf(fact.session, TaskEvent.SessionStarted({ session: fact.session }))
        return null
      case "Idle":
        yield* toTaskOf(fact.session, TaskEvent.SessionIdle({ session: fact.session }))
        return null
      case "Renamed":
        yield* toTaskOf(fact.session, TaskEvent.Renamed({ title: fact.title }))
        return null
      case "SubagentStarted":
        yield* toTaskOf(fact.of, TaskEvent.SubagentStarted({ of: fact.of, session: fact.session }))
        return null
      case "SubagentStopped":
        yield* toTaskOf(fact.of, TaskEvent.SubagentStopped({ session: fact.session }))
        return null
      case "Asked":
        yield* toTaskOf(fact.of, TaskEvent.QuestionAsked({ session: fact.of, question: fact.question }))
        return null
      case "Answered":
        yield* toTaskOf(fact.of, TaskEvent.QuestionAnswered({ id: fact.id }))
        return null
    }
  })
