import { Schema } from "effect"

/** An incident.io incident by the number in its reference: 123 for `INC-123`. */
export const IncidentRef = Schema.Struct({
  number: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
})

export type IncidentRef = typeof IncidentRef.Type

/** The kinds of status an incident goes through. incident.io fixes these; an organisation names its own statuses within them. */
export const IncidentCategory = Schema.Literals([
  "triage",
  "live",
  "learning",
  "paused",
  "closed",
  "declined",
  "canceled",
  "merged",
])

export type IncidentCategory = typeof IncidentCategory.Type

/**
 * An incident as incident.io holds it at one moment, without its summary or updates.
 *
 * The gateway reads it and makes no judgement. The hub decides what changed and whom that concerns.
 */
export const IncidentFacts = Schema.Struct({
  ref: IncidentRef,
  name: Schema.String,
  url: Schema.String,
  status: Schema.Struct({ name: Schema.String, category: IncidentCategory }),
  /** The severity's name, or null while the incident has none. */
  severity: Schema.NullOr(Schema.String),
})

export type IncidentFacts = typeof IncidentFacts.Type
