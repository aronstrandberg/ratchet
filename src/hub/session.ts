import { Schema } from "effect"
import { Event, Machine, State } from "effect-machine"
import { toEntity } from "effect-machine/cluster"

export const SessionState = State({
  Unknown: {},
  /** The session works on `task`. */
  Bound: { task: Schema.String },
})

export const SessionEvent = Event({
  Bound: { task: Schema.String },
})

export const sessionMachine = Machine.make({
  state: SessionState,
  event: SessionEvent,
  initial: SessionState.Unknown,
})
  .on(SessionState.Unknown, SessionEvent.Bound, ({ event }) => SessionState.Bound({ task: event.task }))
  .on(SessionState.Bound, SessionEvent.Bound, ({ event }) => SessionState.Bound({ task: event.task }))

export const SessionEntity = toEntity(sessionMachine, { type: "Session" })
