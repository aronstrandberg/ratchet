import { Equal, Schema } from "effect"
import { Event, Machine, State } from "effect-machine"
import { toEntity } from "effect-machine/cluster"
import { Alert, AlertFeedFacts } from "../protocol/alerts.ts"
import { TaskId } from "../protocol/ids.ts"
import type { Relation } from "../protocol/resource.ts"
import type { Attention } from "./attention.ts"
import { Subscriber, attach, detach } from "./subscribers.ts"

const subscribers = { subscribers: Schema.Array(Subscriber) }

/**
 * What the hub holds about a feed of alerts: the alerts it has seen in the last day, and who follows it.
 *
 * A feed never ends. It is followed until its last follower lets it go.
 */
export const AlertFeedState = State({
  Unseen: subscribers,
  Seen: { alerts: Schema.Array(Alert), ...subscribers },
})

/** A feed's state, in either of its tags. */
export type AlertFeedState = typeof AlertFeedState.Type

/** What can happen to a feed as the hub sees it. `at` is when the gateway read it, in milliseconds. */
export const AlertFeedEvent = Event({
  Observed: { facts: AlertFeedFacts, at: Schema.Number },
  Attached: { subscriber: Subscriber },
  Detached: { task: TaskId },
})

/** How long the feed remembers an alert, so that it is not told twice while the gateway reads it. */
const memory = 24 * 60 * 60 * 1000

/** The alerts the cell holds after an observation: what it read, and what it saw before within the last day. */
const merge = (held: ReadonlyArray<Alert>, read: ReadonlyArray<Alert>, at: number): ReadonlyArray<Alert> => {
  const fresh = new Map(read.map((alert) => [alert.id, alert]))

  return [...read, ...held.filter((alert) => !fresh.has(alert.id) && alert.createdAt > at - memory)].toSorted(
    (a, b) => a.createdAt - b.createdAt,
  )
}

const any = [AlertFeedState.Unseen, AlertFeedState.Seen] as const

const isSeen = AlertFeedState.$is("Seen")

/** How a feed's state follows from what happens to it. */
export const alertFeedMachine = Machine.make({
  state: AlertFeedState,
  event: AlertFeedEvent,
  initial: AlertFeedState.Unseen({ subscribers: [] }),
})
  .on(any, AlertFeedEvent.Observed, ({ state, event }) =>
    AlertFeedState.Seen({
      alerts: merge(isSeen(state) ? state.alerts : [], event.facts.alerts, event.at),
      subscribers: state.subscribers,
    }),
  )
  .on(any, AlertFeedEvent.Attached, ({ state, event }) =>
    AlertFeedState.with(state, { subscribers: attach(state.subscribers, event.subscriber) }),
  )
  .on(any, AlertFeedEvent.Detached, ({ state, event }) =>
    AlertFeedState.with(state, { subscribers: detach(state.subscribers, event.task) }),
  )

/** A feed as a cell: one per feed key. */
export const AlertFeedEntity = toEntity(alertFeedMachine, { type: "AlertFeed" })

/** Something that happened in a feed, in terms a task can act on. */
export const Change = Schema.TaggedUnion({
  /** An alert the feed had not seen started firing. */
  Fired: { alert: Alert },
  /** An alert the feed saw firing resolved. */
  Resolved: { alert: Alert },
})

/** One thing that happened in a feed. */
export type Change = typeof Change.Type

/** Whether an observation says nothing the cell does not hold already, so that it need not be stored again. */
export const repeats = (state: AlertFeedState, facts: AlertFeedFacts): boolean => {
  if (!isSeen(state)) return false
  const held = new Map(state.alerts.map((alert) => [alert.id, alert]))

  return facts.alerts.every((alert) => {
    const known = held.get(alert.id)

    return known !== undefined && Equal.equals(Schema.encodeSync(Alert)(known), Schema.encodeSync(Alert)(alert))
  })
}

/**
 * What changed between two observations of a feed.
 *
 * The first observation reports nothing: a session that subscribes starts from the alerts that come after.
 * An alert first seen after it resolved reports nothing either.
 */
export const changes = (before: AlertFeedState, after: AlertFeedState): ReadonlyArray<Change> => {
  if (!isSeen(before) || !isSeen(after)) return []
  const held = new Map(before.alerts.map((alert) => [alert.id, alert]))

  return after.alerts.flatMap((alert): ReadonlyArray<Change> => {
    const known = held.get(alert.id)

    if (known === undefined) return alert.firing ? [Change.cases.Fired.make({ alert })] : []

    return known.firing && !alert.firing ? [Change.cases.Resolved.make({ alert })] : []
  })
}

/**
 * What a change asks of a session of a task with this relation to the feed, or null for nothing.
 *
 * A task that owns the feed watches the alerts: it acts on one that fires, and notes one that resolves. A
 * task that waits on a feed or has it for context hears nothing, since a feed never ends.
 */
export const attention = (relation: Relation, change: Change): Attention | null =>
  relation !== "owns" ? null : Change.match(change, { Fired: () => "act" as const, Resolved: () => "note" as const })

/** One line a session can read, for one change. The title is the alert rule's, not a person's. */
export const describe = (change: Change): string =>
  Change.match(change, {
    Fired: ({ alert }) =>
      `Firing${alert.priority === null ? "" : ` (${alert.priority})`}${alert.teams.length === 0 ? "" : ` for ${alert.teams.join(", ")}`}: ${alert.title} ${alert.url}`,
    Resolved: ({ alert }) => `Resolved: ${alert.title}`,
  })

/** Where a feed stands, in a few words: how many alerts fire now. */
export const summaryOf = (state: AlertFeedState): string =>
  isSeen(state) ? `${state.alerts.filter((alert) => alert.firing).length} firing` : "unseen"
