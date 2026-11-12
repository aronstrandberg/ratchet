import { Effect, Schema } from "effect"
import { Event, Machine, State } from "effect-machine"
import { toEntity } from "effect-machine/cluster"

export const SessionState = State({
  Unknown: {},
  /** The session works on `task`. `earlier` holds the tasks it worked on before, the latest first. */
  Bound: {
    task: Schema.String,
    earlier: Schema.Array(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  },
})

export type SessionState = typeof SessionState.Type

const isBound = SessionState.$is("Bound")

/** The task a session works on, or null when the hub has not bound the session yet. */
export const boundTask = (state: SessionState): string | null => (isBound(state) ? state.task : null)

/** Every task a session has worked on: the current one first, then the earlier ones, the latest first. */
export const tasksOf = (state: SessionState): ReadonlyArray<string> =>
  isBound(state) ? [state.task, ...state.earlier] : []

export const SessionEvent = Event({
  Bound: { task: Schema.String },
})

export const sessionMachine = Machine.make({
  state: SessionState,
  event: SessionEvent,
  initial: SessionState.Unknown,
})
  .on(SessionState.Unknown, SessionEvent.Bound, ({ event }) => SessionState.Bound({ task: event.task, earlier: [] }))
  .on(SessionState.Bound, SessionEvent.Bound, ({ state, event }) =>
    event.task === state.task
      ? state
      : SessionState.Bound({
          task: event.task,
          earlier: [state.task, ...state.earlier.filter((task) => task !== event.task)],
        }),
  )

export const SessionEntity = toEntity(sessionMachine, { type: "Session" })
