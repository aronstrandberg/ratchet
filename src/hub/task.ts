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
  /** At least one of the task's sessions is running. */
  Active: { ...details, running: Schema.Array(Schema.String) },
})
export type TaskState = typeof TaskState.Type

export const TaskEvent = Event({
  Created: {
    title: Schema.String,
    parent: Schema.NullOr(Schema.String),
    session: Schema.String,
  },
  SessionStarted: { session: Schema.String },
  SessionIdle: { session: Schema.String },
  Renamed: { title: Schema.String },
})

const without = (sessions: ReadonlyArray<string>, session: string) => sessions.filter((s) => s !== session)

export const taskMachine = Machine.make({
  state: TaskState,
  event: TaskEvent,
  initial: TaskState.Unborn,
})
  .on(TaskState.Unborn, TaskEvent.Created, ({ event }) =>
    TaskState.Idle({ title: event.title, parent: event.parent, sessions: [event.session] }),
  )
  .on(TaskState.Idle, TaskEvent.SessionStarted, ({ state, event }) =>
    TaskState.Active({ ...state, running: [event.session] }),
  )
  .on(TaskState.Active, TaskEvent.SessionStarted, ({ state, event }) =>
    TaskState.Active({ ...state, running: [...without(state.running, event.session), event.session] }),
  )
  .on(TaskState.Active, TaskEvent.SessionIdle, ({ state, event }) => {
    const running = without(state.running, event.session)
    return running.length === 0
      ? TaskState.Idle({ title: state.title, parent: state.parent, sessions: state.sessions })
      : TaskState.Active({ ...state, running })
  })
  .on(TaskState.Idle, TaskEvent.Renamed, ({ state, event }) => TaskState.Idle({ ...state, title: event.title }))
  .on(TaskState.Active, TaskEvent.Renamed, ({ state, event }) => TaskState.Active({ ...state, title: event.title }))

export const TaskEntity = toEntity(taskMachine, { type: "Task" })
