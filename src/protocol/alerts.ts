import { Schema } from "effect"

/**
 * The alerts incident.io holds for one team, or for every team when `team` is null. A team is named as
 * incident.io names it, in lower case, such as `devex`.
 */
export const AlertFeedRef = Schema.Struct({
  team: Schema.NullOr(Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-z0-9][a-z0-9_.-]*$/)))),
})

export type AlertFeedRef = typeof AlertFeedRef.Type

/** One alert, without its description. */
export const Alert = Schema.Struct({
  id: Schema.String,
  /** The alert's title, which the rule that raised it sets. */
  title: Schema.String,
  firing: Schema.Boolean,
  /** The priority's name, such as `Low Urgency`, or null when it has none. */
  priority: Schema.NullOr(Schema.String),
  /** The teams the alert names, in lower case. */
  teams: Schema.Array(Schema.String),
  /** Where the alert is seen in the system that raised it, or on incident.io. */
  url: Schema.String,
  /** When incident.io received it, in milliseconds since the epoch. */
  createdAt: Schema.Number,
})

export type Alert = typeof Alert.Type

/**
 * The alerts of a feed that incident.io received lately, as it holds them at one moment.
 *
 * Lately is the last two hours, so a gateway that was away for less than that misses nothing. An alert that
 * resolves later than that is not seen to resolve.
 */
export const AlertFeedFacts = Schema.Struct({
  ref: AlertFeedRef,
  alerts: Schema.Array(Alert),
})

export type AlertFeedFacts = typeof AlertFeedFacts.Type
