import { Context, Effect, Layer, Option, Random, Schema } from "effect"
import { SessionId, TaskId } from "../protocol/ids.ts"
import { Binding, SessionFact, SessionOrigin } from "../protocol/session.ts"
import * as Cells from "./cells.ts"
import type { IndexError } from "./index-store.ts"
import * as SessionControl from "./session-control.ts"
import { boundTask, tasksOf as tasksOfState } from "./session.ts"
import { type LiveTask, SubagentKind, TaskEvent, firstTaskOf, isUnborn } from "./task.ts"

/** A task as a session sees it. */
export const TaskView = Schema.Struct({
  id: TaskId,
  title: Schema.String,
  state: Schema.Literals(["NeedsMe", "Working", "Watching", "Idle"]),
  parent: Schema.NullOr(TaskId),
  sessions: Schema.Array(SessionId),
  subagents: Schema.Array(Schema.Struct({ session: SessionId, kind: SubagentKind })),
  /** The titles of the questions the task waits on me for. */
  questions: Schema.Array(Schema.String),
})

export type TaskView = typeof TaskView.Type

/** The hub has no task for a session: it has not seen the session yet. */
export class NoTask extends Schema.TaggedError<NoTask>()("NoTask", { session: SessionId }) {
  override get message(): string {
    return `the hub has no task for session ${this.session}`
  }
}

/** A session named a task it has not worked on. */
export class NotATaskOfSession extends Schema.TaggedError<NotATaskOfSession>()("NotATaskOfSession", {
  session: SessionId,
  task: TaskId,
}) {
  override get message(): string {
    return `session ${this.session} has not worked on ${this.task}`
  }
}

/** How a new task relates to the one its session leaves: below it, or beside it under the same parent. */
export const Placement = Schema.Literals(["child", "sibling"])

export type Placement = typeof Placement.Type

type Failure = Cells.CellUnavailable | IndexError

/** The tasks and the sessions that work on them. */
export interface Interface {
  /**
   * Applies what the gateway saw of OpenCode's sessions, in order, and returns the task of each main session
   * the facts opened.
   *
   * Applying the same fact twice changes nothing, so the gateway can send it again after a reconnect.
   */
  readonly observe: (facts: ReadonlyArray<SessionFact>) => Effect.Effect<ReadonlyArray<Binding>, Failure>
  /** The task a session works on now. */
  readonly taskOf: (session: SessionId) => Effect.Effect<TaskId, NoTask | Cells.CellUnavailable>
  /** Every task a session has worked on, the current one first. */
  readonly tasksOf: (session: SessionId) => Effect.Effect<ReadonlyArray<TaskId>, NoTask | Cells.CellUnavailable>
  readonly current: (session: SessionId) => Effect.Effect<TaskView, NoTask | Cells.CellUnavailable>
  /**
   * Makes a new task the session's current task, and returns it with the task the session left.
   *
   * What the old task held for this session moves along: that it runs, its subagents and its open questions.
   */
  readonly start: (
    session: SessionId,
    title: string,
    placement: Placement,
  ) => Effect.Effect<{ readonly task: TaskView; readonly left: TaskId }, NoTask | Failure>
  /**
   * Gives a task the session has worked on a new title. `task` is the session's current task when it is not
   * given.
   */
  readonly rename: (
    session: SessionId,
    title: string,
    task: Option.Option<TaskId>,
  ) => Effect.Effect<TaskView, NoTask | NotATaskOfSession | Failure>
  /** Forks a session into a new one that works on a child task, and prompts the fork. */
  readonly fork: (
    session: SessionId,
    title: string,
    prompt: string,
  ) => Effect.Effect<SessionId, SessionControl.SessionControlFailed>
  /** Records what a subagent of the session is for. */
  readonly declareSubagent: (
    session: SessionId,
    subagent: SessionId,
    kind: SubagentKind,
  ) => Effect.Effect<TaskView, NoTask | Failure>
}

/** The hub's tasks. */
export class Service extends Context.Service<Service, Interface>()("@ratchet/hub/Tasks") {}

type Opened = typeof SessionFact.cases.Opened.Type

const view = (id: TaskId, state: LiveTask): TaskView => ({
  id,
  title: state.title,
  state: state._tag,
  parent: state.parent,
  sessions: state.sessions,
  subagents: state.subagents.map(({ session, kind }) => ({ session, kind })),
  questions: state.questions.map((question) => question.title),
})

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

const hex = (word: number) => word.toString(16).padStart(8, "0")

/** A new task ID: `tsk_` and 32 random hex digits. */
const newTaskId = Effect.map(
  Effect.all([0, 1, 2, 3].map(() => Random.nextIntBetween(0, 0xffff_ffff))),
  (words) => TaskId.make(`tsk_${words.map(hex).join("")}`),
)

/** Builds the tasks on the cells and on the hub's control over sessions. */
export const make = Effect.gen(function* () {
  const cells = yield* Cells.Service
  const control = yield* SessionControl.Service

  const boundOf = (session: SessionId) => Effect.map(cells.session(session), boundTask)

  const taskOf = Effect.fn("Tasks.taskOf")(function* (session: SessionId) {
    const task = yield* boundOf(session)

    return task === null ? yield* new NoTask({ session }) : task
  })

  const tasksOf = Effect.fn("Tasks.tasksOf")(function* (session: SessionId) {
    const tasks = tasksOfState(yield* cells.session(session))

    return tasks.length === 0 ? yield* new NoTask({ session }) : tasks
  })

  const liveTaskOf = Effect.fn("Tasks.liveTaskOf")(function* (session: SessionId) {
    const id = yield* taskOf(session)
    const state = yield* cells.task(id)

    return isUnborn(state) ? yield* new NoTask({ session }) : { id, state }
  })

  /** Sends an event to the task a session works on, when the hub knows the session. */
  const toTaskOf = (session: SessionId, event: typeof TaskEvent.Type) =>
    Effect.flatMap(boundOf(session), (task) =>
      task === null ? Effect.succeed(Option.none<Binding>()) : Effect.as(cells.sendTask(task, event), Option.none<Binding>()),
    )

  /**
   * Gives a session's first task the session's title.
   *
   * A task the session started later keeps the title it was started with.
   */
  const nameFirstTask = Effect.fn("Tasks.nameFirstTask")(function* (session: SessionId, title: string) {
    const first = firstTaskOf(session)
    const state = yield* cells.task(first)

    if (!isUnborn(state) && state.title !== title) yield* cells.sendTask(first, TaskEvent.Renamed({ title }))
  })

  const open = Effect.fn("Tasks.open")(function* (fact: Opened) {
    const bound = yield* boundOf(fact.session)
    const task = bound ?? firstTaskOf(fact.session)

    if (bound === null) {
      const parent = yield* SessionOrigin.match(fact.origin, {
        Root: () => Effect.succeed(null),
        Fork: ({ of }) => boundOf(of),
      })

      yield* cells.sendTask(task, TaskEvent.Created({ title: fact.title ?? "Untitled", parent, session: fact.session }))
      yield* cells.bind(fact.session, task)
    }

    const binding = Option.some(Binding.make({ session: fact.session, task }))
    // A snapshot repeats what the task already holds. Send only what differs, so the journal does not grow.
    const state = yield* cells.task(task)

    if (isUnborn(state)) return binding

    if (fact.title !== null) yield* nameFirstTask(fact.session, fact.title)

    if (differs(state, fact)) {
      yield* cells.sendTask(
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

  const apply = (fact: SessionFact) =>
    SessionFact.match(fact, {
      Opened: open,
      Started: ({ session }) => toTaskOf(session, TaskEvent.SessionStarted({ session })),
      Idle: ({ session }) => toTaskOf(session, TaskEvent.SessionIdle({ session })),
      Renamed: ({ session, title }) => Effect.as(nameFirstTask(session, title), Option.none<Binding>()),
      SubagentStarted: ({ of, session }) => toTaskOf(of, TaskEvent.SubagentStarted({ of, session })),
      SubagentStopped: ({ of, session }) => toTaskOf(of, TaskEvent.SubagentStopped({ session })),
      Asked: ({ of, question }) => toTaskOf(of, TaskEvent.QuestionAsked({ session: of, question })),
      Answered: ({ of, id }) => toTaskOf(of, TaskEvent.QuestionAnswered({ id })),
    })

  const observe = Effect.fn("Tasks.observe")(function* (facts: ReadonlyArray<SessionFact>) {
    const bindings: Array<Binding> = []

    for (const fact of facts) {
      const binding = yield* apply(fact)

      if (Option.isSome(binding)) bindings.push(binding.value)
    }

    return bindings
  })

  const current = Effect.fn("Tasks.current")(function* (session: SessionId) {
    const { id, state } = yield* liveTaskOf(session)

    return view(id, state)
  })

  const start = Effect.fn("Tasks.start")(function* (session: SessionId, title: string, placement: Placement) {
    const from = yield* liveTaskOf(session)
    const id = yield* newTaskId
    const mine = from.state.subagents.filter((subagent) => subagent.of === session)
    const parent = placement === "child" ? from.id : from.state.parent

    yield* cells.sendTask(id, TaskEvent.Created({ title, parent, session }))

    let state = yield* cells.sendTask(
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

    for (const subagent of mine) {
      if (subagent.kind === "watching") {
        state = yield* cells.sendTask(id, TaskEvent.SubagentDeclared({ session: subagent.session, kind: "watching" }))
      }
    }

    yield* cells.bind(session, id)
    yield* cells.sendTask(from.id, TaskEvent.Observed({ session, running: false, subagents: [], questions: [] }))
    // The session's metadata is a copy for people who read the session. The gateway writes it again each
    // time it connects to OpenCode, so a failed write here is repaired then.
    yield* control.recordTask(session, id).pipe(
      Effect.catch((failure) => Effect.logWarning("the session's metadata does not name its new task yet", failure)),
    )

    return isUnborn(state) ? yield* new NoTask({ session }) : { task: view(id, state), left: from.id }
  })

  const rename = Effect.fn("Tasks.rename")(function* (session: SessionId, title: string, task: Option.Option<TaskId>) {
    const worked = yield* tasksOf(session)
    const id = Option.isSome(task) ? task.value : yield* taskOf(session)

    if (!worked.includes(id)) return yield* new NotATaskOfSession({ session, task: id })

    const state = yield* cells.sendTask(id, TaskEvent.Renamed({ title }))

    return isUnborn(state) ? yield* new NoTask({ session }) : view(id, state)
  })

  const declareSubagent = Effect.fn("Tasks.declareSubagent")(function* (
    session: SessionId,
    subagent: SessionId,
    kind: SubagentKind,
  ) {
    const id = yield* taskOf(session)
    const state = yield* cells.sendTask(id, TaskEvent.SubagentDeclared({ session: subagent, kind }))

    return isUnborn(state) ? yield* new NoTask({ session }) : view(id, state)
  })

  return Service.of({
    observe,
    taskOf,
    tasksOf,
    current,
    start,
    rename,
    fork: (session, title, prompt) => control.fork(session, title, prompt),
    declareSubagent,
  })
})

/** The tasks, still in need of the cells and of control over sessions. */
export const layerWithoutDependencies = Layer.effect(Service, make)
