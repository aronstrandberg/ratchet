import { Schema } from "effect"
import { SessionId, TaskId } from "./ids.ts"

/** Where a main session came from. A fork gets a child task of the origin's task. */
export const SessionOrigin = Schema.TaggedUnion({
  Root: {},
  Fork: { of: SessionId },
})

export type SessionOrigin = typeof SessionOrigin.Type

/** Something a session waits on me for: a question form or a permission request. */
export const Question = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["form", "permission"]),
  title: Schema.String,
})

export type Question = typeof Question.Type

/**
 * What the gateway tells the hub about OpenCode sessions. Facts carry no message content.
 *
 * A main session is a root or a fork. Subagent sessions are reported against the main session they work for,
 * in `of`, however deep they nest.
 */
export const SessionFact = Schema.TaggedUnion({
  /** The whole observable state of a main session. Replaces what the hub holds for it. */
  Opened: {
    session: SessionId,
    title: Schema.NullOr(Schema.String),
    origin: SessionOrigin,
    running: Schema.Boolean,
    subagents: Schema.Array(SessionId),
    questions: Schema.Array(Question),
  },
  Started: { session: SessionId },
  Idle: { session: SessionId },
  Renamed: { session: SessionId, title: Schema.String },
  SubagentStarted: { of: SessionId, session: SessionId },
  SubagentStopped: { of: SessionId, session: SessionId },
  Asked: { of: SessionId, question: Question },
  Answered: { of: SessionId, id: Schema.String },
})

export type SessionFact = typeof SessionFact.Type

/** The task a main session works on, as the hub decided it. */
export const Binding = Schema.Struct({ session: SessionId, task: TaskId })

export type Binding = typeof Binding.Type
