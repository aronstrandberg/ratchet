import { Context, type Effect, Schema } from "effect"
import { causeText } from "../failure.ts"
import { type ResourceFacts, ResourceKey, type ResourceRef, labelOfKey } from "../protocol/resource.ts"

/** The resource's own system has nothing under this reference, or the gateway cannot see it. */
export class ResourceNotFound extends Schema.TaggedError<ResourceNotFound>()("ResourceNotFound", {
  resource: ResourceKey,
}) {
  override get message(): string {
    return `${labelOfKey(this.resource)} was not found, or the gateway cannot see it`
  }
}

/** The gateway is not signed in to the resource's own system, so it can read no resource of this kind. */
export class ResourceNotSignedIn extends Schema.TaggedError<ResourceNotSignedIn>()("ResourceNotSignedIn", {
  resource: ResourceKey,
  /** The name the system's sign-in is kept under, such as `linear`. */
  system: Schema.String,
}) {
  override get message(): string {
    return `${labelOfKey(this.resource)} cannot be read: Ratchet is not signed in to ${this.system}`
  }
}

/** A resource could not be read now. Reading it again later may work. */
export class ResourceUnreadable extends Schema.TaggedError<ResourceUnreadable>()("ResourceUnreadable", {
  resource: ResourceKey,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `${labelOfKey(this.resource)} could not be read: ${causeText(this.cause)}`
  }
}

/** Where the hub reads a resource's current state. The gateway reads it from the resource's own system. */
export interface Interface {
  /** Reads a resource now. The gateway keeps reading a resource the hub watches. */
  readonly read: (
    ref: ResourceRef,
  ) => Effect.Effect<ResourceFacts, ResourceNotFound | ResourceNotSignedIn | ResourceUnreadable>
}

/** The hub's source of observations. */
export class Service extends Context.Service<Service, Interface>()("@ratchet/hub/ResourceSource") {}
