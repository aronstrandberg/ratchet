import { Schema } from "effect"
import { Event, Machine, State } from "effect-machine"
import { toEntity } from "effect-machine/cluster"

const details = {
  title: Schema.String,
  parent: Schema.NullOr(Schema.String),
  sessions: Schema.Array(Schema.String),
}

export const TaskState = State({
  Unborn: {},
  Idle: details,
  Active: details,
})

export const TaskEvent = Event({
  Created: {
    title: Schema.String,
    parent: Schema.NullOr(Schema.String),
    session: Schema.String,
  },
  SessionStarted: { session: Schema.String },
  SessionIdle: { session: Schema.String },
})

export const taskMachine = Machine.make({
  state: TaskState,
  event: TaskEvent,
  initial: TaskState.Unborn,
})
  .on(TaskState.Unborn, TaskEvent.Created, ({ event }) =>
    TaskState.Idle({ title: event.title, parent: event.parent, sessions: [event.session] }),
  )
  .on(TaskState.Idle, TaskEvent.SessionStarted, ({ state }) => TaskState.Active.with(state, {}))
  .on(TaskState.Active, TaskEvent.SessionIdle, ({ state }) => TaskState.Idle.with(state, {}))

export const TaskEntity = toEntity(taskMachine, { type: "Task" })
