import { Layer, ManagedRuntime, Option, Result } from "effect"
import * as Config from "../config.ts"
import type { Env } from "../env.ts"
import * as Telemetry from "../telemetry.ts"
import * as GitHub from "./github.ts"
import * as HubBinding from "./hub-binding.ts"
import * as IncidentIo from "./incident-io.ts"
import * as Linear from "./linear.ts"
import * as OpenCode from "./opencode.ts"
import * as SignIns from "./sign-ins.ts"

/** The gateway: its connections to OpenCode, GitHub, Linear and incident.io, its sign-ins, and its line to the hub. */
const layer = (env: Env, config: Config.Gateway) =>
  Layer.mergeAll(
    OpenCode.layer(config.opencode),
    GitHub.layer(config.github),
    Option.match(config.linear, { onNone: () => Linear.layerNotConfigured, onSome: Linear.layer }),
    Option.match(config.incidentIo, { onNone: () => IncidentIo.layerNotConfigured, onSome: IncidentIo.layer }),
    SignIns.layer(env.SIGN_IN, config.signIns),
    HubBinding.layer(env.HUB),
  ).pipe(Layer.provideMerge(Telemetry.layer(config.tracing, "ratchet-gateway")))

/** What an effect may require when it runs on the gateway's runtime. */
export type Services = Layer.Success<ReturnType<typeof layer>>

/** The gateway's runtime in one isolate. */
export type Runtime = ManagedRuntime.ManagedRuntime<Services, never>

let gateway: Runtime | undefined

/**
 * The gateway's runtime in this isolate, built on first use.
 *
 * A setting the gateway cannot start with is the failure, with a message that names the setting.
 */
export const runtime = (env: Env): Result.Result<Runtime, Config.InvalidConfig> => {
  if (gateway !== undefined) return Result.succeed(gateway)

  return Result.map(Config.gateway(env), (config) => {
    gateway = ManagedRuntime.make(layer(env, config))

    return gateway
  })
}
