import { Context, Effect, Layer, Redacted, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { causeText } from "../failure.ts"
import { IncidentCategory, type IncidentFacts, type IncidentRef } from "../protocol/incident.ts"

/** incident.io has no incident under this number, or the key cannot see it. */
export class IncidentNotFound extends Schema.TaggedError<IncidentNotFound>()("IncidentNotFound", {
  number: Schema.Number,
}) {
  override get message(): string {
    return `incident.io has no incident INC-${this.number}, or the key cannot see it`
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

/** Where incident.io's API is, and the API key the gateway reads it with. */
export interface Config {
  readonly url: string
  readonly key: Redacted.Redacted<string>
}

/** incident.io's incidents, as the gateway reads them. */
export interface Interface {
  /** Reads an incident's current state, without its summary or updates. */
  readonly read: (ref: IncidentRef) => Effect.Effect<IncidentFacts, IncidentNotFound | IncidentIoUnavailable>
}

/** The gateway's connection to incident.io. */
export class Service extends Context.Service<Service, Interface>()("@ratchet/gateway/IncidentIo") {}

const Shown = Schema.Struct({
  incident: Schema.Struct({
    name: Schema.String,
    permalink: Schema.optional(Schema.String),
    incident_status: Schema.Struct({ name: Schema.String, category: IncidentCategory }),
    severity: Schema.optional(Schema.NullOr(Schema.Struct({ name: Schema.String }))),
  }),
})

/** Builds the connection on an HTTP client. Nothing is sent until a read runs. */
export const make = (config: Config): Effect.Effect<Interface, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient

    const read = Effect.fn("IncidentIo.read")(function* (ref: IncidentRef) {
      yield* Effect.annotateCurrentSpan("incident.number", ref.number)

      // The path takes an incident's long ID, and also the number of its reference.
      const response = yield* HttpClientRequest.get(`${config.url}/v2/incidents/${ref.number}`).pipe(
        HttpClientRequest.bearerToken(Redacted.value(config.key)),
        http.execute,
        Effect.mapError((cause) => new IncidentIoUnavailable({ operation: "read", cause })),
      )

      if (response.status === 404) return yield* new IncidentNotFound({ number: ref.number })

      const shown = yield* HttpClientResponse.filterStatusOk(response).pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(Shown)),
        Effect.mapError((cause) => new IncidentIoUnavailable({ operation: "read", cause })),
      )

      const facts: IncidentFacts = {
        ref: { number: ref.number },
        name: shown.incident.name,
        url: shown.incident.permalink ?? "",
        status: shown.incident.incident_status,
        severity: shown.incident.severity?.name ?? null,
      }

      return facts
    })

    return Service.of({ read })
  })

/** The connection to incident.io, still in need of an HTTP client. */
export const layerWithoutDependencies = (config: Config): Layer.Layer<Service, never, HttpClient.HttpClient> =>
  Layer.effect(Service, make(config))

/** The connection to incident.io over `fetch`. */
export const layer = (config: Config): Layer.Layer<Service> =>
  layerWithoutDependencies(config).pipe(Layer.provide(FetchHttpClient.layer))

/** A connection that fails every read, for a gateway that was given no key for incident.io. */
export const layerNotConfigured: Layer.Layer<Service> = Layer.succeed(
  Service,
  Service.of({
    read: () => Effect.fail(new IncidentIoUnavailable({ operation: "read", cause: "INCIDENT_IO_API_KEY is not set" })),
  }),
)
