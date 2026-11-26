import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { FetchHttpClient, type HttpClient } from "effect/http"
import { causeText } from "../failure.ts"
import type { Alert, AlertFeedFacts, AlertFeedRef } from "../protocol/alerts.ts"
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
  /** Reads the alerts of a feed that incident.io received in the last two hours. */
  readonly alerts: (feed: AlertFeedRef) => Effect.Effect<AlertFeedFacts, IncidentIoUnavailable | SignIns.NotSignedIn>
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

/** What `alert_list` answers, without the alerts' descriptions. */
const Listed = Schema.Struct({
  alerts: Schema.NullOr(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        title: Schema.String,
        status: Schema.String,
        priority: Schema.optional(Schema.NullOr(Schema.Struct({ name: Schema.String }))),
        attributes: Schema.optional(Schema.NullOr(Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.Unknown })))),
        source_url: Schema.optional(Schema.String),
        created_at: Schema.String,
      }),
    ),
  ),
  pagination: Schema.Struct({ has_more: Schema.Boolean, next_cursor: Schema.optional(Schema.String) }),
})

const Teams = Schema.Struct({ teams: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })) })

/** How far back a read of a feed looks. A gateway away for less than this misses no alert. */
const window = 2 * 60 * 60 * 1000

/** The most pages of fifty a read of a feed takes. Two hours of every team's alerts fit in about one. */
const pages = 6

/** An alert's `Team` attribute: the names of teams, written in any case, or their IDs on incident.io. */
const decodeTeams = Schema.decodeUnknownOption(Schema.NullOr(Schema.Array(Schema.String)))

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

    /** The ID incident.io gives each team, by the team's name in lower case. Read once, when first needed. */
    const teamIds = yield* Effect.cached(
      incidentIo.call("team_list", {}, Teams).pipe(
        Effect.map((listed) => new Map(listed.teams.map((team) => [team.name.toLowerCase(), team.id.toLowerCase()]))),
        Effect.catchTags({
          McpUnavailable: ({ operation, cause }) => Effect.fail(new IncidentIoUnavailable({ operation, cause })),
          ToolFailed: ({ tool, problem }) => Effect.fail(new IncidentIoUnavailable({ operation: tool, cause: problem })),
        }),
      ),
    )

    const alerts = Effect.fn("IncidentIo.alerts")(function* (feed: AlertFeedRef) {
      yield* Effect.annotateCurrentSpan("incident_io.team", feed.team ?? "all")
      const since = new Date((yield* Clock.currentTimeMillis) - window).toISOString()
      // A team's ID stands for its name in an alert, so names are compared after IDs are put back as names.
      const names = new Map([...(yield* teamIds)].map(([name, id]) => [id, name]))
      const found: Array<Alert> = []
      let after: string | undefined = undefined

      for (let page = 0; page < pages; page++) {
        const query =
          after === undefined
            ? { page_size: 50, created_after: since, include: ["attributes"] }
            : { page_size: 50, created_after: since, include: ["attributes"], after }

        const listed: typeof Listed.Type = yield* incidentIo
          .call("alert_list", query, Listed)
          .pipe(
            Effect.catchTags({
              McpUnavailable: ({ operation, cause }) => Effect.fail(new IncidentIoUnavailable({ operation, cause })),
              ToolFailed: ({ tool, problem }) => Effect.fail(new IncidentIoUnavailable({ operation: tool, cause: problem })),
            }),
          )

        for (const alert of listed.alerts ?? []) {
          const teams = (alert.attributes ?? [])
            .filter((attribute) => attribute.name === "Team")
            .flatMap((attribute) => Option.getOrElse(decodeTeams(attribute.value), () => null) ?? [])
            .map((value) => names.get(value.toLowerCase()) ?? value.toLowerCase())

          if (feed.team !== null && !teams.includes(feed.team)) continue

          found.push({
            id: alert.id,
            title: alert.title,
            firing: alert.status === "firing",
            priority: alert.priority?.name ?? null,
            teams,
            url: alert.source_url ?? `https://app.incident.io/lovable/alerts/${alert.id}`,
            createdAt: Date.parse(alert.created_at),
          })
        }

        if (!listed.pagination.has_more || listed.pagination.next_cursor === undefined) break
        after = listed.pagination.next_cursor
      }

      const facts: AlertFeedFacts = { ref: feed, alerts: found }

      return facts
    })

    return Service.of({ read, alerts })
  })

/** The connection to incident.io, still in need of an HTTP client and the gateway's sign-ins. */
export const layerWithoutDependencies = (
  config: Config,
): Layer.Layer<Service, never, HttpClient.HttpClient | SignIns.Service> => Layer.effect(Service, make(config))

/** The connection to incident.io over `fetch`, still in need of the gateway's sign-ins. */
export const layer = (config: Config): Layer.Layer<Service, never, SignIns.Service> =>
  layerWithoutDependencies(config).pipe(Layer.provide(FetchHttpClient.layer))
