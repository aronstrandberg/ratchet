import { Context, Effect, Layer, Option, Ref, Schema } from "effect"
import { FetchHttpClient, type HttpClient } from "effect/http"
import { causeText } from "../failure.ts"
import * as McpClient from "./mcp-client.ts"
import type * as SignIns from "./sign-ins.ts"

/** Buildkite did not answer, refused the request, or answered with something this adapter cannot read. */
export class BuildkiteUnavailable extends Schema.TaggedError<BuildkiteUnavailable>()("BuildkiteUnavailable", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Buildkite failed (${this.operation}): ${causeText(this.cause)}`
  }
}

/** Where Buildkite's MCP server is, and which organization's builds to read. */
export interface Config {
  readonly url: string
  readonly organization: string
}

/** A build as Buildkite lists it, with the pipeline its address names. */
export interface Listed {
  readonly id: string
  readonly pipeline: string
  readonly number: number
  /** Buildkite's word for where the build stands, such as `running`, `failing`, `failed`, `passed` or `skipped`. */
  readonly state: string
  readonly url: string
  readonly commit: string
  /** When the build was created, in milliseconds since the epoch. */
  readonly createdAt: number
}

type Failure = BuildkiteUnavailable | SignIns.NotSignedIn

/** Buildkite's builds, as the gateway reads them. */
export interface Interface {
  /**
   * The builds of a commit in every pipeline, the oldest first. A build on a merge queue's branch is left
   * out: it ran before the commit was merged.
   */
  readonly buildsOf: (commit: string) => Effect.Effect<ReadonlyArray<Listed>, Failure>
  /** Whether a schedule started a build. Such a build builds whatever commit is newest at that hour. */
  readonly scheduled: (build: Listed) => Effect.Effect<boolean, Failure>
  /** The jobs that failed in a build, each by its step's key or else its name. None for a build that has not failed. */
  readonly failedJobs: (build: Listed) => Effect.Effect<ReadonlyArray<string>, Failure>
}

/** The gateway's connection to Buildkite. */
export class Service extends Context.Service<Service, Interface>()("@ratchet/gateway/Buildkite") {}

/** What `list_builds` answers for one build. It names no pipeline, and not what started the build. */
const Build = Schema.Struct({
  id: Schema.String,
  branch: Schema.String,
  commit: Schema.String,
  state: Schema.String,
  number: Schema.Int,
  created_at: Schema.DateFromString,
  web_url: Schema.String,
})

const Builds = Schema.Struct({ items: Schema.Array(Build) })

/** What `get_build` adds: what started the build, such as `webhook`, `trigger_job` or `schedule`. */
const Shown = Schema.Struct({ source: Schema.String })

const Jobs = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      name: Schema.optional(Schema.NullOr(Schema.String)),
      step_key: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
})

/** The branches GitHub's merge queue builds on before it merges. */
const mergeQueue = "gh-readonly-queue/"

/** The pipeline in a build's address, `https://buildkite.com/<organization>/<pipeline>/builds/<number>`. */
const pipelineIn = (address: string): string | undefined => /^https?:\/\/[^/]+\/[^/]+\/([^/]+)\/builds\/\d+/.exec(address)?.[1]

const hasFailed = (build: Listed) => build.state === "failing" || build.state === "failed"

/** Builds the connection on Buildkite's MCP server. Nothing is sent until a read runs. */
export const make = (config: Config): Effect.Effect<Interface, never, HttpClient.HttpClient | SignIns.Service> =>
  Effect.gen(function* () {
    const buildkite = yield* McpClient.make({ url: config.url, system: "buildkite" })
    // What started a build never changes, and neither do the failed jobs of a build that is over.
    const scheduledBuilds = yield* Ref.make(new Map<string, boolean>())
    const failures = yield* Ref.make(new Map<string, ReadonlyArray<string>>())
    const organization = { org_slug: config.organization }

    const remembered = <A>(held: Ref.Ref<Map<string, A>>, id: string) =>
      Effect.map(Ref.get(held), (map) => Option.fromUndefinedOr(map.get(id)))

    const remember = <A>(held: Ref.Ref<Map<string, A>>, id: string, value: A) =>
      Ref.update(held, (map) => new Map(map).set(id, value))

    /** A failure of the server or of a tool, in this adapter's words. */
    const unavailable = <A>(
      call: Effect.Effect<A, McpClient.McpUnavailable | McpClient.ToolFailed | SignIns.NotSignedIn>,
    ): Effect.Effect<A, Failure> =>
      call.pipe(
        Effect.catchTags({
          McpUnavailable: ({ operation, cause }) => Effect.fail(new BuildkiteUnavailable({ operation, cause })),
          ToolFailed: ({ tool, problem }) => Effect.fail(new BuildkiteUnavailable({ operation: tool, cause: problem })),
        }),
      )

    const one = (build: Listed) => ({ ...organization, pipeline_slug: build.pipeline, build_number: String(build.number) })

    const buildsOf = Effect.fn("Buildkite.buildsOf")(function* (commit: string) {
      yield* Effect.annotateCurrentSpan("buildkite.commit", commit)
      const { items } = yield* buildkite.call("list_builds", { ...organization, commit, per_page: 100 }, Builds)

      return items
        .flatMap((build): ReadonlyArray<Listed> => {
          const pipeline = pipelineIn(build.web_url)

          return pipeline === undefined || build.branch.startsWith(mergeQueue)
            ? []
            : [
                {
                  id: build.id,
                  pipeline,
                  number: build.number,
                  state: build.state,
                  url: build.web_url,
                  commit: build.commit,
                  createdAt: build.created_at.getTime(),
                },
              ]
        })
        .toSorted((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    }, unavailable)

    const scheduled = Effect.fn("Buildkite.scheduled")(function* (build: Listed) {
      const known = yield* remembered(scheduledBuilds, build.id)

      if (Option.isSome(known)) return known.value

      const { source } = yield* buildkite.call("get_build", one(build), Shown)
      yield* remember(scheduledBuilds, build.id, source === "schedule")

      return source === "schedule"
    }, unavailable)

    const failedJobs = Effect.fn("Buildkite.failedJobs")(function* (build: Listed) {
      if (!hasFailed(build)) return []
      const known = yield* remembered(failures, build.id)

      if (Option.isSome(known)) return known.value

      const jobs = yield* buildkite.call("list_jobs", { ...one(build), state: "failed,timed_out" }, Jobs)
      const names = jobs.items.map((job) => job.step_key ?? job.name ?? "a job without a name")

      // More jobs can fail while a build is failing, so only a failed build's jobs are kept.
      if (build.state === "failed") yield* remember(failures, build.id, names)

      return names
    }, unavailable)

    return Service.of({ buildsOf, scheduled, failedJobs })
  })

/** The connection to Buildkite, still in need of an HTTP client and the gateway's sign-ins. */
export const layerWithoutDependencies = (
  config: Config,
): Layer.Layer<Service, never, HttpClient.HttpClient | SignIns.Service> => Layer.effect(Service, make(config))

/** The connection to Buildkite over `fetch`, still in need of the gateway's sign-ins. */
export const layer = (config: Config): Layer.Layer<Service, never, SignIns.Service> =>
  layerWithoutDependencies(config).pipe(Layer.provide(FetchHttpClient.layer))
