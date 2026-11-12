import { Effect, Schema } from "effect"
import { SessionEntity, SessionEvent, boundTask } from "./session.ts"
import * as Index from "./index-store.ts"
import { type LiveTask, TaskEntity, TaskEvent, isUnborn } from "./task.ts"

/** A task as a session sees it. */
export const TaskView = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  state: Schema.Literals(["NeedsMe", "Working", "Watching", "Idle"]),
  parent: Schema.NullOr(Schema.String),
  sessions: Schema.Array(Schema.String),
  subagents: Schema.Array(Schema.Struct({ session: Schema.String, kind: Schema.Literals(["working", "watching"]) })),
  questions: Schema.Array(Schema.String),
})

export type TaskView = typeof TaskView.Type

export class NoTask extends Schema.TaggedError<NoTask>()("NoTask", { session: Schema.String }) {}

const view = (id: string, state: LiveTask): TaskView => ({
  id,
  title: state.title,
  state: state._tag,
  parent: state.parent,
  sessions: state.sessions,
  subagents: state.subagents.map(({ session, kind }) => ({ session, kind })),
  questions: state.questions.map((question) => question.title),
})

/** The task a session works on now. It fails for a session the hub has not bound to a task. */
export const taskOf = (session: string) =>
  Effect.flatMap(SessionEntity.client, (sessions) => sessions(session).GetState()).pipe(
    Effect.flatMap((state) => {
      const task = boundTask(state)

      return task === null ? Effect.fail(new NoTask({ session })) : Effect.succeed(task)
    }),
  )

const stateOf = (session: string) =>
  Effect.gen(function* () {
    const id = yield* taskOf(session)
    const state = yield* (yield* TaskEntity.client)(id).GetState()

    if (isUnborn(state)) return yield* new NoTask({ session })

    return { id, state }
  })

/** The task a session works on now. */
export const current = (session: string) => Effect.map(stateOf(session), ({ id, state }) => view(id, state))

/**
 * Makes a new task the session's current task, and returns it with the task the session left.
 *
 * What the old task held for this session moves along: that it runs, its subagents and its open questions.
 */
export const start = (db: Index.Database, session: string, title: string, relation: "child" | "sibling") =>
  Effect.gen(function* () {
    const tasks = yield* TaskEntity.client
    const sessions = yield* SessionEntity.client

    const send = (task: string, event: typeof TaskEvent.Type) =>
      tasks(task)
        .Send({ event })
        .pipe(Effect.tap((state) => Index.put(db, task, state)))

    const from = yield* stateOf(session)
    const id = `tsk_${crypto.randomUUID().replaceAll("-", "")}`
    const mine = from.state.subagents.filter((subagent) => subagent.of === session)

    yield* send(id, TaskEvent.Created({ title, parent: relation === "child" ? from.id : from.state.parent, session }))
    yield* send(
      id,
      TaskEvent.Observed({
        session,
        running: from.state.running.includes(session),
        subagents: mine.map((subagent) => subagent.session),
        questions: from.state.questions
          .filter((question) => question.session === session)
          .map(({ id, kind, title }) => ({ id, kind, title })),
      }),
    )
    let state = yield* tasks(id).GetState()

    for (const subagent of mine) {
      if (subagent.kind === "watching") {
        state = yield* send(id, TaskEvent.SubagentDeclared({ session: subagent.session, kind: "watching" }))
      }
    }

    yield* sessions(session).Send({ event: SessionEvent.Bound({ task: id }) })
    yield* send(from.id, TaskEvent.Observed({ session, running: false, subagents: [], questions: [] }))

    if (isUnborn(state)) return yield* new NoTask({ session })

    return { task: view(id, state), left: from.id }
  })

/** Records what a subagent of the session is for. */
export const declareSubagent = (db: Index.Database, session: string, subagent: string, kind: "working" | "watching") =>
  Effect.gen(function* () {
    const id = yield* taskOf(session)
    const state = yield* (yield* TaskEntity.client)(id).Send({ event: TaskEvent.SubagentDeclared({ session: subagent, kind }) })
    yield* Index.put(db, id, state)

    if (isUnborn(state)) return yield* new NoTask({ session })

    return view(id, state)
  })
