import { Option, Redacted, Result, Schema } from "effect"
import type { Target } from "./gateway/grant.ts"
import type { System } from "./gateway/systems.ts"
import type * as WakeGate from "./gateway/wake-gate.ts"
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
  /** The decision model that screens wake-ups, as `provider/model`. `opencode/jev-1.13-free` unless set. */
  readonly WAKE_SCREEN_MODEL?: string
  readonly GITHUB_TOKEN?: string
  /** Where Linear's MCP server is. Only a scratch Ratchet sets it, to a stand-in. */
  readonly LINEAR_MCP_URL?: string
  /** Where incident.io's MCP server is. Only a scratch Ratchet sets it, to a stand-in. */
  readonly INCIDENT_IO_MCP_URL?: string
  /** Where Buildkite's MCP server is. Only a scratch Ratchet sets it, to a stand-in. */
  readonly BUILDKITE_MCP_URL?: string
  /** The Buildkite organization whose builds the gateway reads. */
  readonly BUILDKITE_ORGANIZATION?: string
  /** Where the Spacelift account is, such as `https://lovable.app.spacelift.io`. A scratch Ratchet sets it to a stand-in. */
  readonly SPACELIFT_URL?: string
  /** Where the webhook proxy is. Only a scratch Ratchet sets it, to a stand-in. */
  readonly WEBHOOK_PROXY_URL?: string
  /** The repositories whose GitHub events reach the webhook proxy, as `owner/repo` separated by commas. */
  readonly WEBHOOK_PROXY_REPOS?: string
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
  /** How the gateway decides whether a wake-up starts a turn. */
  readonly wakeGate: WakeGate.Config
  readonly github: { readonly token: Redacted.Redacted<string> }
  /**
   * What the gateway signs in to for each system: the address the system protects, and the scope to ask for.
   * For Linear and incident.io the address is their MCP server, which is also where the gateway reads them.
   */
  readonly signIns: Readonly<Record<System, Target>>
  readonly buildkite: { readonly organization: string }
  /** Where the Spacelift account is. Its GraphQL API is under `/graphql` there. */
  readonly spacelift: { readonly url: string }
  /** Where the webhook proxy is, and the repositories whose events reach it, in lower case. */
  readonly proxy: { readonly url: string; readonly repos: ReadonlyArray<string> }
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
    const spacelift = Option.getOrElse(optional(settings.SPACELIFT_URL), () => "https://lovable.app.spacelift.io")
    const proxy = Option.getOrElse(optional(settings.WEBHOOK_PROXY_URL), () => "https://lov-webhook-proxy.lovable.app")
    const proxyRepos = Option.getOrElse(optional(settings.WEBHOOK_PROXY_REPOS), () => "lovablelabs/lovable")
    const screenModel = Option.getOrElse(optional(settings.WAKE_SCREEN_MODEL), () => "opencode/jev-1.13-free")
    const slash = screenModel.indexOf("/")

    if (slash <= 0) {
      return yield* Result.fail(new InvalidConfig({ setting: "WAKE_SCREEN_MODEL", problem: "is not provider/model" }))
    }

    return {
      opencode: { url, password: Redacted.make(password) },
      // Thresholds read off a replay of a week of wake-ups: about a third start a turn.
      wakeGate: {
        model: { providerID: screenModel.slice(0, slash), id: screenModel.slice(slash + 1) },
        messages: 14,
        actionable: 0.5,
        known: 0.5,
      },
      github: { token: Redacted.make(token) },
      signIns: {
        // The proxy admits Lovable staff, and learns who that is from the account's email.
        "webhook-proxy": { resource: `${proxy}/api/public/mcp`, scope: "openid email offline" },
        // Reading is all the gateway does in Linear.
        linear: { resource: Option.getOrElse(optional(settings.LINEAR_MCP_URL), () => "https://mcp.linear.app/mcp"), scope: "read" },
        "incident-io": {
          resource: Option.getOrElse(optional(settings.INCIDENT_IO_MCP_URL), () => "https://mcp.incident.io/mcp"),
          scope: null,
        },
        // The account's API, and reading is all the gateway does there.
        spacelift: { resource: spacelift, scope: "graphql:read" },
        // Reading is all the gateway does in Buildkite.
        buildkite: {
          resource: Option.getOrElse(optional(settings.BUILDKITE_MCP_URL), () => "https://mcp.buildkite.com/mcp"),
          scope: "read",
        },
      },
      buildkite: { organization: Option.getOrElse(optional(settings.BUILDKITE_ORGANIZATION), () => "lovable") },
      spacelift: { url: spacelift },
      proxy: {
        url: proxy,
        repos: proxyRepos.split(",").flatMap((repo) => (repo.trim() === "" ? [] : [repo.trim().toLowerCase()])),
      },
      tracing: tracing(settings),
    }
  })
