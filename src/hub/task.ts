import { Schema } from "effect"
import { Event, Machine, State } from "effect-machine"
import { toEntity } from "effect-machine/cluster"
import { Relation, WorkStatus } from "../protocol/pull-request.ts"
import { Question } from "../protocol/session.ts"

/** A running subagent. `watching` marks one that monitors something and does no work on the task. */
const Subagent = Schema.Struct({
  session: Schema.String,
  of: Schema.String,
  kind: Schema.Literals(["working", "watching"]),
})

const OpenQuestion = Schema.Struct({ ...Question.fields, session: Schema.String })

/** A resource the task follows, with what the attaching session last said about its work on it. */
const Attachment = Schema.Struct({
  resource: Schema.String,
  relation: Relation,
  session: Schema.String,
  status: WorkStatus,
  note: Schema.String,
})

/** A message for one of the task's sessions that has not reached it yet. */
const Wake = Schema.Struct({ id: Schema.String, session: Schema.String, text: Schema.String })

const details = {
  title: Schema.String,
  parent: Schema.NullOr(Schema.String),
  sessions: Schema.Array(Schema.String),
  /** The main sessions that run now. */
  running: Schema.Array(Schema.String),
  subagents: Schema.Array(Subagent),
  questions: Schema.Array(OpenQuestion),
  attachments: Schema.Array(Attachment),
  outbox: Schema.Array(Wake),
}

type Details = Schema.Struct.Type<typeof details>

/**
 * A task's state. The tag is what the board shows, and `settle` derives it from the details:
 * an open question beats running work, and work beats a subagent that only watches.
 */
export const TaskState = State({
  Unborn: {},
  NeedsMe: details,
  Working: details,
  Watching: details,
  Idle: details,
})

export type TaskState = typeof TaskState.Type

/** A task that exists, in any of its board states. */
export type LiveTask = Exclude<TaskState, { _tag: "Unborn" }>

export const isUnborn = TaskState.$is("Unborn")

export const TaskEvent = Event({
  Created: {
    title: Schema.String,
    parent: Schema.NullOr(Schema.String),
    session: Schema.String,
  },
  /** Everything observable about one main session at once. Replaces what the task holds for it. */
  Observed: {
    session: Schema.String,
    running: Schema.Boolean,
    subagents: Schema.Array(Schema.String),
    questions: Schema.Array(Question),
  },
  SessionStarted: { session: Schema.String },
  SessionIdle: { session: Schema.String },
  Renamed: { title: Schema.String },
  SubagentStarted: { of: Schema.String, session: Schema.String },
  SubagentStopped: { session: Schema.String },
  /** The owning session says what a subagent is for. */
  SubagentDeclared: { session: Schema.String, kind: Schema.Literals(["working", "watching"]) },
  QuestionAsked: { session: Schema.String, question: Question },
  QuestionAnswered: { id: Schema.String },
  Attached: { resource: Schema.String, relation: Relation, session: Schema.String },
  Detached: { resource: Schema.String },
  /** The attaching session says where its work on a resource stands. */
  StatusSet: { resource: Schema.String, status: WorkStatus, note: Schema.String },
  WakeQueued: { id: Schema.String, session: Schema.String, text: Schema.String },
  WakeDelivered: { id: Schema.String },
})

const open = [TaskState.NeedsMe, TaskState.Working, TaskState.Watching, TaskState.Idle] as const

const detailsOf = (state: Details): Details => ({
  title: state.title,
  parent: state.parent,
  sessions: state.sessions,
  running: state.running,
  subagents: state.subagents,
  questions: state.questions,
  attachments: state.attachments,
  outbox: state.outbox,
})

const settle = (details: Details) => {
  const waitsOnMe = details.attachments.some((attachment) => attachment.status === "waiting-user")

  if (details.questions.length > 0 || waitsOnMe) return TaskState.NeedsMe(details)

  if (details.running.length > 0 || details.subagents.some((s) => s.kind === "working")) {
    return TaskState.Working(details)
  }

  if (details.subagents.length > 0) return TaskState.Watching(details)

  return TaskState.Idle(details)
}

const without = <A>(items: ReadonlyArray<A>, drop: (item: A) => boolean) => items.filter((item) => !drop(item))

export const taskMachine = Machine.make({
  state: TaskState,
  event: TaskEvent,
  initial: TaskState.Unborn,
})
  .on(TaskState.Unborn, TaskEvent.Created, ({ event }) =>
    TaskState.Idle({
      title: event.title,
      parent: event.parent,
      sessions: [event.session],
      running: [],
      subagents: [],
      questions: [],
      attachments: [],
      outbox: [],
    }),
  )
  .on(open, TaskEvent.Observed, ({ state, event }) => {
    const kinds = new Map(state.subagents.map((s) => [s.session, s.kind]))

    return settle({
      ...detailsOf(state),
      running: [...without(state.running, (s) => s === event.session), ...(event.running ? [event.session] : [])],
      subagents: [
        ...without(state.subagents, (s) => s.of === event.session),
        // A subagent that still runs keeps the kind its session declared.
        ...event.subagents.map((session) => ({ session, of: event.session, kind: kinds.get(session) ?? "working" })),
      ],
      questions: [
        ...without(state.questions, (q) => q.session === event.session),
        ...event.questions.map((question) => ({ ...question, session: event.session })),
      ],
    })
  })
  .on(open, TaskEvent.SessionStarted, ({ state, event }) =>
    settle({
      ...detailsOf(state),
      running: [...without(state.running, (s) => s === event.session), event.session],
    }),
  )
  .on(open, TaskEvent.SessionIdle, ({ state, event }) =>
    settle({ ...detailsOf(state), running: without(state.running, (s) => s === event.session) }),
  )
  .on(open, TaskEvent.Renamed, ({ state, event }) => settle({ ...detailsOf(state), title: event.title }))
  .on(open, TaskEvent.SubagentStarted, ({ state, event }) =>
    settle({
      ...detailsOf(state),
      subagents: [
        ...without(state.subagents, (s) => s.session === event.session),
        { session: event.session, of: event.of, kind: "working" },
      ],
    }),
  )
  .on(open, TaskEvent.SubagentStopped, ({ state, event }) =>
    settle({ ...detailsOf(state), subagents: without(state.subagents, (s) => s.session === event.session) }),
  )
  .on(open, TaskEvent.SubagentDeclared, ({ state, event }) =>
    settle({
      ...detailsOf(state),
      subagents: state.subagents.map((s) => (s.session === event.session ? { ...s, kind: event.kind } : s)),
    }),
  )
  .on(open, TaskEvent.QuestionAsked, ({ state, event }) =>
    settle({
      ...detailsOf(state),
      questions: [
        ...without(state.questions, (q) => q.id === event.question.id),
        { ...event.question, session: event.session },
      ],
    }),
  )
  .on(open, TaskEvent.QuestionAnswered, ({ state, event }) =>
    settle({ ...detailsOf(state), questions: without(state.questions, (q) => q.id === event.id) }),
  )
  .on(open, TaskEvent.Attached, ({ state, event }) => {
    const known = state.attachments.find((a) => a.resource === event.resource)

    return settle({
      ...detailsOf(state),
      attachments: [
        ...without(state.attachments, (a) => a.resource === event.resource),
        // Attaching again keeps what the session reported about its work.
        { resource: event.resource, relation: event.relation, session: event.session, status: known?.status ?? "unassigned", note: known?.note ?? "" },
      ],
    })
  })
  .on(open, TaskEvent.Detached, ({ state, event }) =>
    settle({ ...detailsOf(state), attachments: without(state.attachments, (a) => a.resource === event.resource) }),
  )
  .on(open, TaskEvent.StatusSet, ({ state, event }) =>
    settle({
      ...detailsOf(state),
      attachments: state.attachments.map((a) =>
        a.resource === event.resource ? { ...a, status: event.status, note: event.note } : a,
      ),
    }),
  )
  .on(open, TaskEvent.WakeQueued, ({ state, event }) =>
    settle({
      ...detailsOf(state),
      outbox: [...without(state.outbox, (w) => w.id === event.id), { id: event.id, session: event.session, text: event.text }],
    }),
  )
  .on(open, TaskEvent.WakeDelivered, ({ state, event }) =>
    settle({ ...detailsOf(state), outbox: without(state.outbox, (w) => w.id === event.id) }),
  )

export const TaskEntity = toEntity(taskMachine, { type: "Task" })
