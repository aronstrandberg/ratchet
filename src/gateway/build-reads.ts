import { Context, Effect, Layer, Option } from "effect"
import { BuildReadReply, parseBuildAddress } from "../protocol/build.ts"
import * as Buildkite from "./buildkite.ts"
import type * as SignIns from "./sign-ins.ts"

/** The gateway operation that reads one Buildkite build from an untrusted browser address. */
export interface Interface {
  /**
   * Reads one build or returns the closed reason the HTTP route acts on.
   *
   * Integration causes stay inside the gateway and never become reply fields.
   */
  readonly read: (address: string) => Effect.Effect<BuildReadReply>
}

/** The gateway's read of one Buildkite build. */
export class Service extends Context.Service<Service, Interface>()("@ratchet/gateway/BuildReads") {}

/** Builds the single-build reading on the gateway's Buildkite connection. */
export const make: Effect.Effect<Interface, never, Buildkite.Service> = Effect.gen(function* () {
  const buildkite = yield* Buildkite.Service

  const read = Effect.fn("BuildReads.read")(function* (address: string) {
    const parsed = parseBuildAddress(address)

    if (Option.isNone(parsed)) {
      const message = address.trim() === "" ? "A Buildkite build address is required" : "Not a Buildkite build address"

      return BuildReadReply.cases.BadRequest.make({ message })
    }

    return yield* buildkite.read(parsed.value).pipe(
      Effect.map((build) => BuildReadReply.cases.Read.make({ build })),
      Effect.catchTags({
        BuildNotFound: () => Effect.succeed(BuildReadReply.cases.NotFound.make({})),
        BuildOrganizationRefused: (failure) =>
          Effect.succeed(BuildReadReply.cases.BadRequest.make({ message: failure.message })),
        BuildkiteUnavailable: () =>
          Effect.succeed(BuildReadReply.cases.Unavailable.make({ reason: "unavailable" })),
        NotSignedIn: () =>
          Effect.succeed(BuildReadReply.cases.Unavailable.make({ reason: "not-signed-in" })),
      }),
    )
  })

  return Service.of({ read })
})

/** The single-build reading, still in need of the gateway's Buildkite connection. */
export const layerWithoutDependencies: Layer.Layer<Service, never, Buildkite.Service> = Layer.effect(Service, make)

/** The single-build reading with its production Buildkite connection. */
export const layer = (config: Buildkite.Config): Layer.Layer<Service, never, SignIns.Service> =>
  layerWithoutDependencies.pipe(Layer.provide(Buildkite.layer(config)))
