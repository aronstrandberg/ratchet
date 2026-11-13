import { Schema } from "effect"

/** A Linear issue as Linear addresses it: its team key and number, such as `DX-1550`. */
export const LinearIssueRef = Schema.Struct({
  identifier: Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Z][A-Z0-9]*-[1-9][0-9]*$/))),
})

export type LinearIssueRef = typeof LinearIssueRef.Type

/**
 * A Linear issue as Linear holds it at one moment, without its description or any comment text.
 *
 * The gateway reads it and makes no judgement. The hub decides what changed and whom that concerns.
 */
export const LinearIssueFacts = Schema.Struct({
  ref: LinearIssueRef,
  title: Schema.String,
  url: Schema.String,
  /** The workflow state: its name on the team's board, and its type, which is the same word on every team. */
  state: Schema.Struct({
    name: Schema.String,
    /** `triage`, `backlog`, `unstarted`, `started`, `completed`, `canceled` or `duplicate`. */
    type: Schema.String,
  }),
  assignee: Schema.NullOr(Schema.Struct({ id: Schema.String, name: Schema.String })),
  /** The latest comments, oldest first: who wrote each, and nothing of what it says. */
  comments: Schema.Array(Schema.Struct({ id: Schema.String, author: Schema.String })),
  /** The Linear user the gateway's key belongs to, to tell my own activity from other people's. */
  viewer: Schema.Struct({ id: Schema.String, name: Schema.String }),
})

export type LinearIssueFacts = typeof LinearIssueFacts.Type
