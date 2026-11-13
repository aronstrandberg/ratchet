import { Effect, Schema } from "effect"
import { Event, Machine, State } from "effect-machine"
import { toEntity } from "effect-machine/cluster"
import { SessionId, TaskId } from "../protocol/ids.ts"
import { Outcome, PullRequestKey, Relation, WorkStatus } from "../protocol/pull-request.ts"
import { Question } from "../protocol/session.ts"
import { Wake } from "../protocol/wake.ts"

/** A running subagent. `watching` marks one that monitors something and does no work on the task. */
const Subagent = Schema.Struct({
  session: SessionId,
  /** The main session it works for. */
  of: SessionId,
  kind: Schema.Literals(["working", "watching"]),
})

const OpenQuestion = Schema.Struct({ ...Question.fields, session: SessionId })

/**
 * A resource the task follows, with what the attaching session last said about its work on it.
 *
 * Once the resource has ended, `status` is history: it no longer says who has to act.
 */
const Attachment = Schema.Struct({
  resource: PullRequestKey,
  relation: Relation,
  session: SessionId,
  status: WorkStatus,
  note: Schema.String,
  ended: Schema.NullOr(Outcome).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
})

/** A resource a task follows, as the task holds it. */
export type Attachment = typeof Attachment.Type

const details = {
  title: Schema.String,
  parent: Schema.NullOr(TaskId),
  sessions: Schema.Array(SessionId),
  /** The main sessions that run now. */
  running: Schema.Array(SessionId),
  subagents: Schema.Array(Subagent),
  questions: Schema.Array(OpenQuestion),
  attachments: Schema.Array(Attachment),
  /** Messages for the task's sessions that have not reached them yet. */
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

/** A task's state, in any of its tags. */
export type TaskState = typeof TaskState.Type

/** A task that exists, in any of its board states. */
export type LiveTask = Exclude<TaskState, { _tag: "Unborn" }>

/** Whether a task has not been created yet: no event has reached its cell. */
export const isUnborn = TaskState.$is("Unborn")

/** The task a main session starts when the hub first sees it. It is named after the session. */
export const firstTaskOf = (session: SessionId): TaskId => TaskId.make(`tsk_${session.replace(/^ses_/, "")}`)

/** What a subagent is for: `working` on the task, or `watching` something without working on it. */
export const SubagentKind = Schema.Literals(["working", "watching"])

export type SubagentKind = typeof SubagentKind.Type

/** What can happen to a task. */
export const TaskEvent = Event({
  Created: {
    title: Schema.String,
    parent: Schema.NullOr(TaskId),
    session: SessionId,
  },
  /** Everything observable about one main session at once. Replaces what the task holds for it. */
  Observed: {
    session: SessionId,
    running: Schema.Boolean,
    subagents: Schema.Array(SessionId),
    questions: Schema.Array(Question),
  },
  SessionStarted: { session: SessionId },
  SessionIdle: { session: SessionId },
  Renamed: { title: Schema.String },
  SubagentStarted: { of: SessionId, session: SessionId },
  SubagentStopped: { session: SessionId },
  /** The owning session says what a subagent is for. */
  SubagentDeclared: { session: SessionId, kind: SubagentKind },
  QuestionAsked: { session: SessionId, question: Question },
  QuestionAnswered: { id: Schema.String },
  Attached: { resource: PullRequestKey, relation: Relation, session: SessionId },
  Detached: { resource: PullRequestKey },
  /** The attaching session says where its work on a resource stands. */
  StatusSet: { resource: PullRequestKey, status: WorkStatus, note: Schema.String },
  ResourceEnded: { resource: PullRequestKey, outcome: Outcome },
  WakeQueued: {
    id: Schema.String,
    session: SessionId,
    text: Schema.String,
    /** When it was queued, in milliseconds since the epoch. */
    at: Schema.Number.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
  },
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
  const waitsOnMe = details.attachments.some(
    (attachment) => attachment.ended === null && attachment.status === "waiting-user",
  )

  if (details.questions.length > 0 || waitsOnMe) return TaskState.NeedsMe(details)

  if (details.running.length > 0 || details.subagents.some((s) => s.kind === "working")) {
    return TaskState.Working(details)
  }

  if (details.subagents.length > 0) return TaskState.Watching(details)

  return TaskState.Idle(details)
}

const without = <A>(items: ReadonlyArray<A>, drop: (item: A) => boolean) => items.filter((item) => !drop(item))

/** How a task's state follows from what happens to it. */
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
        {
          resource: event.resource,
          relation: event.relation,
          session: event.session,
          status: known?.status ?? "unassigned",
          note: known?.note ?? "",
          ended: null,
        },
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
  .on(open, TaskEvent.ResourceEnded, ({ state, event }) =>
    settle({
      ...detailsOf(state),
      attachments: state.attachments.map((a) => (a.resource === event.resource ? { ...a, ended: event.outcome } : a)),
    }),
  )
  .on(open, TaskEvent.WakeQueued, ({ state, event }) =>
    settle({
      ...detailsOf(state),
      outbox: [
        ...without(state.outbox, (w) => w.id === event.id),
        { id: event.id, session: event.session, text: event.text, queuedAt: event.at },
      ],
    }),
  )
  .on(open, TaskEvent.WakeDelivered, ({ state, event }) =>
    settle({ ...detailsOf(state), outbox: without(state.outbox, (w) => w.id === event.id) }),
  )

/** A task as a cell: one per task ID. */
export const TaskEntity = toEntity(taskMachine, { type: "Task" })
