import { Context, type Effect, Schema } from "effect"
import { causeText } from "../failure.ts"
import type { ResourceFacts, ResourceRef } from "../protocol/resource.ts"
import type { Binding, SessionFact } from "../protocol/session.ts"

/** The hub did not take a report, or its answer could not be read. */
export class HubUnavailable extends Schema.TaggedError<HubUnavailable>()("HubUnavailable", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `the hub did not take ${this.operation}: ${causeText(this.cause)}`
  }
}

/** What the gateway tells the hub, and the little it asks back. */
export interface Interface {
  /** Reports facts about sessions in order. The hub answers with the task of each main session they opened. */
  readonly sessionFacts: (facts: ReadonlyArray<SessionFact>) => Effect.Effect<ReadonlyArray<Binding>, HubUnavailable>
  /** Reports an observation of a resource. */
  readonly resourceFacts: (observed: ResourceFacts) => Effect.Effect<void, HubUnavailable>
  /** The resources the hub wants read again. */
  readonly watchedResources: Effect.Effect<ReadonlyArray<ResourceRef>, HubUnavailable>
  /** Asks the hub to try its undelivered wake-ups again. */
  readonly deliverWakes: Effect.Effect<void, HubUnavailable>
}

/** The gateway's line to the hub. */
export class Service extends Context.Service<Service, Interface>()("@ratchet/gateway/HubReports") {}
