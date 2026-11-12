import { Effect } from "effect"
import { type Binding, SessionFact, SessionOrigin } from "../protocol/session.ts"
import * as Index from "./index-store.ts"
import { SessionEntity, SessionEvent, boundTask } from "./session.ts"
import { type LiveTask, TaskEntity, TaskEvent, isUnborn } from "./task.ts"

type Opened = typeof SessionFact.cases.Opened.Type

/** The task a main session starts when the hub first sees it. */
const taskIdOf = (session: string) => `tsk_${session.replace(/^ses_/, "")}`

const sameSet = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
  a.length === b.length && a.every((item) => b.includes(item))

/** Whether an `Opened` fact says anything the task does not already hold about that session. */
const differs = (state: LiveTask, fact: Opened) =>
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
export const apply = (db: Index.Database, fact: SessionFact) =>
  Effect.gen(function* () {
    const sessions = yield* SessionEntity.client
    const tasks = yield* TaskEntity.client

    const send = (task: string, event: typeof TaskEvent.Type) =>
      tasks(task)
        .Send({ event })
        .pipe(Effect.tap((state) => Index.put(db, task, state)))

    const taskOf = (session: string) => sessions(session).GetState().pipe(Effect.map(boundTask))

    const toTaskOf = (session: string, event: typeof TaskEvent.Type) =>
      Effect.flatMap(taskOf(session), (task) => (task === null ? Effect.succeed(null) : Effect.as(send(task, event), null)))

    const open = (fact: Opened) =>
      Effect.gen(function* () {
        let task = yield* taskOf(fact.session)

        if (task === null) {
          task = taskIdOf(fact.session)

          const parent = yield* SessionOrigin.match(fact.origin, {
            Root: () => Effect.succeed(null),
            Fork: ({ of }) => taskOf(of),
          })

          yield* send(task, TaskEvent.Created({ title: fact.title ?? "Untitled", parent, session: fact.session }))
          yield* sessions(fact.session).Send({ event: SessionEvent.Bound({ task }) })
        }

        const binding: Binding = { session: fact.session, task }
        // A snapshot repeats what the task already holds. Send only what differs, so the journal does not grow.
        const state = yield* tasks(task).GetState()

        if (isUnborn(state)) return binding

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
      })

    return yield* SessionFact.match(fact, {
      Opened: open,
      Started: ({ session }) => toTaskOf(session, TaskEvent.SessionStarted({ session })),
      Idle: ({ session }) => toTaskOf(session, TaskEvent.SessionIdle({ session })),
      Renamed: ({ session, title }) => toTaskOf(session, TaskEvent.Renamed({ title })),
      SubagentStarted: ({ of, session }) => toTaskOf(of, TaskEvent.SubagentStarted({ of, session })),
      SubagentStopped: ({ of, session }) => toTaskOf(of, TaskEvent.SubagentStopped({ session })),
      Asked: ({ of, question }) => toTaskOf(of, TaskEvent.QuestionAsked({ session: of, question })),
      Answered: ({ of, id }) => toTaskOf(of, TaskEvent.QuestionAnswered({ id })),
    })
  })
