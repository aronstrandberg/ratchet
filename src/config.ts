import { Option, Redacted, Result, Schema } from "effect"
import type { Target } from "./gateway/grant.ts"
import type { System } from "./gateway/systems.ts"
import * as WakePolicy from "./hub/wake-policy.ts"

/** A setting the service cannot start without is missing or malformed. The message holds no secret. */
export class InvalidConfig extends Schema.TaggedError<InvalidConfig>()("InvalidConfig", {
  setting: Schema.String,
  problem: Schema.String,
}) {
  /** What the service reports when it cannot start. */
  override get message(): string {
    return `${this.setting}: ${this.problem}`
  }
}

/** The settings both halves read as plain variables. Bindings are not settings and stay in `Env`. */
export interface Settings {
  readonly OPENCODE_URL?: string
  readonly OPENCODE_PASSWORD?: string
  readonly GITHUB_TOKEN?: string
  /** Where Linear's MCP server is. Only a scratch Ratchet sets it, to a stand-in. */
  readonly LINEAR_MCP_URL?: string
  /** Where incident.io's MCP server is. Only a scratch Ratchet sets it, to a stand-in. */
  readonly INCIDENT_IO_MCP_URL?: string
  readonly WAKE_SESSIONS?: string
  readonly OTLP_URL?: string
}

/** Where to export traces, when tracing is on. */
export type Tracing = Option.Option<{ readonly url: string }>

/** What the hub needs to know to start. */
export interface Hub {
  readonly wake: WakePolicy.WakePolicy
  readonly tracing: Tracing
}

/** What the gateway needs to know to start. */
export interface Gateway {
  readonly opencode: { readonly url: string; readonly password: Redacted.Redacted<string> }
  readonly github: { readonly token: Redacted.Redacted<string> }
  /**
   * What the gateway signs in to for each system: the address the system protects, and the scope to ask for.
   * For Linear and incident.io the address is their MCP server, which is also where the gateway reads them.
   */
  readonly signIns: Readonly<Record<System, Target>>
  readonly tracing: Tracing
}

const required = (settings: Settings, setting: keyof Settings): Result.Result<string, InvalidConfig> => {
  const value = settings[setting]

  return value === undefined || value === ""
    ? Result.fail(new InvalidConfig({ setting, problem: "it is not set" }))
    : Result.succeed(value)
}

const optional = (value: string | undefined): Option.Option<string> =>
  value === undefined || value === "" ? Option.none() : Option.some(value)

const tracing = (settings: Settings): Tracing =>
  settings.OTLP_URL === undefined || settings.OTLP_URL === "" ? Option.none() : Option.some({ url: settings.OTLP_URL })

/** Parses the hub's settings. */
export const hub = (settings: Settings): Result.Result<Hub, InvalidConfig> =>
  Result.mapBoth(WakePolicy.parse(settings.WAKE_SESSIONS ?? ""), {
    onFailure: (failure) =>
      new InvalidConfig({ setting: "WAKE_SESSIONS", problem: `"${failure.entry}" is not a session ID or *` }),
    onSuccess: (wake) => ({ wake, tracing: tracing(settings) }),
  })

/** Parses the gateway's settings. Secrets are wrapped so that logging the result does not print them. */
export const gateway = (settings: Settings): Result.Result<Gateway, InvalidConfig> =>
  Result.gen(function* () {
    const url = yield* required(settings, "OPENCODE_URL")
    const password = yield* required(settings, "OPENCODE_PASSWORD")
    const token = yield* required(settings, "GITHUB_TOKEN")

    return {
      opencode: { url, password: Redacted.make(password) },
      github: { token: Redacted.make(token) },
      signIns: {
        "webhook-proxy": { resource: "https://lov-webhook-proxy.lovable.app/api/public/mcp", scope: "openid offline" },
        // Reading is all the gateway does in Linear.
        linear: { resource: Option.getOrElse(optional(settings.LINEAR_MCP_URL), () => "https://mcp.linear.app/mcp"), scope: "read" },
        "incident-io": {
          resource: Option.getOrElse(optional(settings.INCIDENT_IO_MCP_URL), () => "https://mcp.incident.io/mcp"),
          scope: null,
        },
      },
      tracing: tracing(settings),
    }
  })
