import { Schema } from "effect"

/** Where a main session came from. A fork gets a child task of the origin's task. */
export const SessionOrigin = Schema.TaggedUnion({
  Root: {},
  Fork: { of: Schema.String },
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
    session: Schema.String,
    title: Schema.NullOr(Schema.String),
    origin: SessionOrigin,
    running: Schema.Boolean,
    subagents: Schema.Array(Schema.String),
    questions: Schema.Array(Question),
  },
  Started: { session: Schema.String },
  Idle: { session: Schema.String },
  Renamed: { session: Schema.String, title: Schema.String },
  SubagentStarted: { of: Schema.String, session: Schema.String },
  SubagentStopped: { of: Schema.String, session: Schema.String },
  Asked: { of: Schema.String, question: Question },
  Answered: { of: Schema.String, id: Schema.String },
})

export type SessionFact = typeof SessionFact.Type

/** The task a main session works on, as the hub decided it. */
export interface Binding {
  readonly session: string
  readonly task: string
}
