import { Schema } from "effect"

/** Identifies a task. A task ID starts with `tsk_`. */
export const TaskId = Schema.String.pipe(Schema.check(Schema.isPattern(/^tsk_[0-9A-Za-z]+$/)), Schema.brand("TaskId"))

export type TaskId = typeof TaskId.Type

/** Identifies an OpenCode session, a main session or a subagent. OpenCode makes the ID, which starts with `ses_`. */
export const SessionId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^ses_[0-9A-Za-z]+$/)),
  Schema.brand("SessionId"),
)

export type SessionId = typeof SessionId.Type
