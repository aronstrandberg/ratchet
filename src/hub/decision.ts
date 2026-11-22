import { Schema } from "effect"
import { Event, Machine, State } from "effect-machine"
import { toEntity } from "effect-machine/cluster"
import { DecisionSpec, Ending } from "../protocol/decision.ts"
import { SessionId, TaskId } from "../protocol/ids.ts"

const raised = {
  spec: DecisionSpec,
  task: TaskId,
  /** The session that raised it, and that an answer wakes. */
  session: SessionId,
  /** When it was raised, in milliseconds since the epoch. */
  raisedAt: Schema.Number,
}

/**
 * What the hub holds about a decision. It is never edited: a session that wants to ask something else
 * raises a new decision that supersedes this one.
 */
export const DecisionState = State({
  Unraised: {},
  Open: raised,
  Closed: { ...raised, ending: Ending, closedAt: Schema.Number },
})

/** A decision's state, in any of its tags. */
export type DecisionState = typeof DecisionState.Type

/** What can happen to a decision. */
export const DecisionEvent = Event({
  Raised: { spec: DecisionSpec, task: TaskId, session: SessionId, at: Schema.Number },
  Closed: { ending: Ending, at: Schema.Number },
})

/** How a decision's state follows from what happens to it. A decision is raised once and closed once. */
export const decisionMachine = Machine.make({
  state: DecisionState,
  event: DecisionEvent,
  initial: DecisionState.Unraised,
})
  .on(DecisionState.Unraised, DecisionEvent.Raised, ({ event }) =>
    DecisionState.Open({ spec: event.spec, task: event.task, session: event.session, raisedAt: event.at }),
  )
  .on(DecisionState.Open, DecisionEvent.Closed, ({ state, event }) =>
    DecisionState.Closed({ ...state, ending: event.ending, closedAt: event.at }),
  )

/** A decision as a cell: one per decision ID. */
export const DecisionEntity = toEntity(decisionMachine, { type: "Decision" })

/** Whether a decision is open. */
export const isOpen = DecisionState.$is("Open")

/** Whether no session has raised a decision with this ID. */
export const isUnraised = DecisionState.$is("Unraised")
