import { Effect, Schema } from "effect"
import { Event, Machine, State } from "effect-machine"
import { toEntity } from "effect-machine/cluster"
import { TaskId } from "../protocol/ids.ts"

/** What the hub holds about a main session: the tasks it has worked on. */
export const SessionState = State({
  Unknown: {},
  /** The session works on `task`. `earlier` holds the tasks it worked on before, the latest first. */
  Bound: {
    task: TaskId,
    earlier: Schema.Array(TaskId).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  },
})

/** A session's state, in either of its tags. */
export type SessionState = typeof SessionState.Type

const isBound = SessionState.$is("Bound")

/** The task a session works on, or null when the hub has not bound the session yet. */
export const boundTask = (state: SessionState): TaskId | null => (isBound(state) ? state.task : null)

/** Every task a session has worked on: the current one first, then the earlier ones, the latest first. */
export const tasksOf = (state: SessionState): ReadonlyArray<TaskId> =>
  isBound(state) ? [state.task, ...state.earlier] : []

/** What can happen to a session. */
export const SessionEvent = Event({
  /** The session starts to work on `task`. */
  Bound: { task: TaskId },
})

/** How a session's state follows from what happens to it. */
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

/** A session as a cell: one per main session ID. */
export const SessionEntity = toEntity(sessionMachine, { type: "Session" })
