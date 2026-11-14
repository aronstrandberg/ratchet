import { Context, Effect, Layer, Schema } from "effect"
import { FetchHttpClient, type HttpClient } from "effect/http"
import { causeText } from "../failure.ts"
import { IncidentCategory, type IncidentFacts, type IncidentRef } from "../protocol/incident.ts"
import * as McpClient from "./mcp-client.ts"
import type * as SignIns from "./sign-ins.ts"

/** incident.io has no incident under this number, or my account cannot see it. */
export class IncidentNotFound extends Schema.TaggedError<IncidentNotFound>()("IncidentNotFound", {
  number: Schema.Number,
}) {
  override get message(): string {
    return `incident.io has no incident INC-${this.number}, or my account cannot see it`
  }
}

/** incident.io did not answer, refused the request, or answered with something this adapter cannot read. */
export class IncidentIoUnavailable extends Schema.TaggedError<IncidentIoUnavailable>()("IncidentIoUnavailable", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `incident.io failed (${this.operation}): ${causeText(this.cause)}`
  }
}

/** Where incident.io's MCP server is. */
export interface Config {
  readonly url: string
}

/** incident.io's incidents, as the gateway reads them. */
export interface Interface {
  /** Reads an incident's current state, without its summary or updates. */
  readonly read: (
    ref: IncidentRef,
  ) => Effect.Effect<IncidentFacts, IncidentNotFound | IncidentIoUnavailable | SignIns.NotSignedIn>
}

/** The gateway's connection to incident.io. */
export class Service extends Context.Service<Service, Interface>()("@ratchet/gateway/IncidentIo") {}

/**
 * The kind of status, in the words of incident.io's API. Its MCP server says `active` and `post-incident`
 * for what the API calls `live` and `learning`.
 */
const Category = Schema.Union([
  IncidentCategory,
  Schema.Literal("active").transform("live"),
  Schema.Literal("post-incident").transform("learning"),
])

/** What `incident_show` answers, without anything people wrote about the incident but its name. */
const Shown = Schema.Struct({
  name: Schema.String,
  permalink: Schema.String,
  status: Schema.Struct({ name: Schema.String, category: Category }),
  severity: Schema.optional(Schema.NullOr(Schema.Struct({ name: Schema.String }))),
})

/** How incident.io's tools say that they have no such incident. */
const missing = /not.?found/i

/** Builds the connection on incident.io's MCP server. Nothing is sent until a read runs. */
export const make = (config: Config): Effect.Effect<Interface, never, HttpClient.HttpClient | SignIns.Service> =>
  Effect.gen(function* () {
    const incidentIo = yield* McpClient.make({ url: config.url, system: "incident-io" })

    const read = Effect.fn("IncidentIo.read")(function* (ref: IncidentRef) {
      yield* Effect.annotateCurrentSpan("incident.number", ref.number)

      const shown = yield* incidentIo.call("incident_show", { id: `INC-${ref.number}` }, Shown).pipe(
        Effect.catchTags({
          McpUnavailable: ({ operation, cause }) => Effect.fail(new IncidentIoUnavailable({ operation, cause })),
          ToolFailed: ({ tool, problem }) =>
            Effect.fail(
              missing.test(problem)
                ? new IncidentNotFound({ number: ref.number })
                : new IncidentIoUnavailable({ operation: tool, cause: problem }),
            ),
        }),
      )

      const facts: IncidentFacts = {
        ref: { number: ref.number },
        name: shown.name,
        url: shown.permalink,
        status: shown.status,
        severity: shown.severity?.name ?? null,
      }

      return facts
    })

    return Service.of({ read })
  })

/** The connection to incident.io, still in need of an HTTP client and the gateway's sign-ins. */
export const layerWithoutDependencies = (
  config: Config,
): Layer.Layer<Service, never, HttpClient.HttpClient | SignIns.Service> => Layer.effect(Service, make(config))

/** The connection to incident.io over `fetch`, still in need of the gateway's sign-ins. */
export const layer = (config: Config): Layer.Layer<Service, never, SignIns.Service> =>
  layerWithoutDependencies(config).pipe(Layer.provide(FetchHttpClient.layer))
