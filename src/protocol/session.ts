import { Schema } from "effect"

/** Where a session came from. A fork gets a task of its own. A subagent joins its parent's task. */
export const SessionOrigin = Schema.TaggedUnion({
  Root: {},
  Fork: { of: Schema.String },
  Subagent: { of: Schema.String },
})
export type SessionOrigin = typeof SessionOrigin.Type

/** What the gateway tells the hub about an OpenCode session. Facts carry no message content. */
export const SessionFact = Schema.TaggedUnion({
  Opened: {
    session: Schema.String,
    title: Schema.NullOr(Schema.String),
    origin: SessionOrigin,
    running: Schema.Boolean,
  },
  Started: { session: Schema.String },
  Idle: { session: Schema.String },
  Renamed: { session: Schema.String, title: Schema.String },
})
export type SessionFact = typeof SessionFact.Type
