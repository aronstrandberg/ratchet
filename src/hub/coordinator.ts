import { Event, Machine, State } from "effect-machine"
import { toEntity } from "effect-machine/cluster"
import { SessionId } from "../protocol/ids.ts"

/** Which session Ratchet tells about the inbox: what waits on me, and what was decided. */
export const CoordinatorState = State({
  Vacant: {},
  Seated: { session: SessionId },
})

/** The coordinator's state, in either of its tags. */
export type CoordinatorState = typeof CoordinatorState.Type

/** What can happen to the coordinator's seat. */
export const CoordinatorEvent = Event({
  /** A session takes the seat, from whichever session held it. */
  Seated: { session: SessionId },
})

/** How the seat follows from what happens to it. */
export const coordinatorMachine = Machine.make({
  state: CoordinatorState,
  event: CoordinatorEvent,
  initial: CoordinatorState.Vacant,
}).on([CoordinatorState.Vacant, CoordinatorState.Seated], CoordinatorEvent.Seated, ({ event }) =>
  CoordinatorState.Seated({ session: event.session }),
)

/** The coordinator's seat as a cell. There is one, under {@link seat}. */
export const CoordinatorEntity = toEntity(coordinatorMachine, { type: "Coordinator" })

/** The ID of the one seat. */
export const seat = "me"

/** The session in the seat, or null. */
export const seatedSession = (state: CoordinatorState): SessionId | null =>
  CoordinatorState.$is("Seated")(state) ? state.session : null
