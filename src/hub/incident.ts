import { Equal, Schema } from "effect"
import { Event, Machine, State } from "effect-machine"
import { toEntity } from "effect-machine/cluster"
import { TaskId } from "../protocol/ids.ts"
import { type IncidentCategory, IncidentFacts } from "../protocol/incident.ts"
import type { Outcome, Relation } from "../protocol/resource.ts"
import { Subscriber, attach, detach } from "./subscribers.ts"

const subscribers = { subscribers: Schema.Array(Subscriber) }

/** What the hub holds about an incident: what incident.io last said, and who follows it. */
export const IncidentState = State({
  Unseen: subscribers,
  Seen: { incident: IncidentFacts, ...subscribers },
})

/** An incident's state, in either of its tags. */
export type IncidentState = typeof IncidentState.Type

/** What can happen to an incident as the hub sees it. */
export const IncidentEvent = Event({
  Observed: { facts: IncidentFacts },
  Attached: { subscriber: Subscriber },
  Detached: { task: TaskId },
})

const any = [IncidentState.Unseen, IncidentState.Seen] as const

/** How an incident's state follows from what happens to it. */
export const incidentMachine = Machine.make({
  state: IncidentState,
  event: IncidentEvent,
  initial: IncidentState.Unseen({ subscribers: [] }),
})
  .on(any, IncidentEvent.Observed, ({ state, event }) =>
    IncidentState.Seen({ incident: event.facts, subscribers: state.subscribers }),
  )
  .on(any, IncidentEvent.Attached, ({ state, event }) =>
    IncidentState.with(state, { subscribers: attach(state.subscribers, event.subscriber) }),
  )
  .on(any, IncidentEvent.Detached, ({ state, event }) =>
    IncidentState.with(state, { subscribers: detach(state.subscribers, event.task) }),
  )

/** An incident as a cell: one per incident key. */
export const IncidentEntity = toEntity(incidentMachine, { type: "Incident" })

/** Something that happened to an incident, in terms a task can act on. */
export const Change = Schema.TaggedUnion({
  /** The incident moved to another status, and is not over. */
  StatusChanged: { from: Schema.String, to: Schema.String },
  SeverityChanged: { from: Schema.NullOr(Schema.String), to: Schema.NullOr(Schema.String) },
  /** The incident is over: closed, declined, canceled or merged into another one. */
  Ended: { status: Schema.String },
})

/** One thing that happened to an incident. */
export type Change = typeof Change.Type

const isSeen = IncidentState.$is("Seen")

/** Whether an observation says nothing the cell does not hold already, so that it need not be stored again. */
export const repeats = (state: IncidentState, facts: IncidentFacts): boolean =>
  isSeen(state) && Equal.equals(state.incident, facts)

const endings: Partial<Record<IncidentCategory, Outcome>> = {
  closed: "closed",
  declined: "declined",
  canceled: "canceled",
  merged: "merged",
}

/** How an incident ended, or null while it can still change. */
export const outcomeOf = (state: IncidentState): Outcome | null =>
  isSeen(state) ? (endings[state.incident.status.category] ?? null) : null

/**
 * What changed between two observations of an incident.
 *
 * The first observation of an incident that is not over reports nothing: a task that attaches reads the state
 * itself.
 */
export const changes = (before: IncidentState, after: IncidentState): ReadonlyArray<Change> => {
  if (!isSeen(after)) return []

  if (outcomeOf(after) !== null) {
    return outcomeOf(before) === null ? [Change.cases.Ended.make({ status: after.incident.status.name })] : []
  }

  if (!isSeen(before)) return []
  const found: Array<Change> = []

  if (before.incident.status.name !== after.incident.status.name) {
    found.push(Change.cases.StatusChanged.make({ from: before.incident.status.name, to: after.incident.status.name }))
  }

  if (before.incident.severity !== after.incident.severity) {
    found.push(Change.cases.SeverityChanged.make({ from: before.incident.severity, to: after.incident.severity }))
  }

  return found
}

const isEnd = Change.isAnyOf(["Ended"])

/**
 * Whether a change should wake a session of a task with this relation to the incident.
 *
 * A task that works on the incident hears every change. A task that waits hears only the end.
 */
export const wakes = (relation: Relation, change: Change): boolean => {
  switch (relation) {
    case "context":
      return false
    case "waits_on":
      return isEnd(change)
    case "owns":
      return true
  }
}

/** One line a session can read, for one change. It holds no text written by other people. */
export const describe = (change: Change): string =>
  Change.match(change, {
    StatusChanged: ({ from, to }) => `Its status changed from ${from} to ${to}.`,
    SeverityChanged: ({ from, to }) => `Its severity changed from ${from ?? "none"} to ${to ?? "none"}.`,
    Ended: ({ status }) => `It is over: ${status}.`,
  })
