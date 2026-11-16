import { Context, type Duration, Effect, Layer, Option, Ref, Schema } from "effect"
import { FetchHttpClient, type HttpClient } from "effect/http"
import { causeText } from "../failure.ts"
import type { Build, CommitBuildsFacts, CommitBuildsRef } from "../protocol/builds.ts"
import * as McpClient from "./mcp-client.ts"
import type * as SignIns from "./sign-ins.ts"

/** Buildkite has no build that the commit's arrival on a branch started, or my account cannot see one. */
export class BuildsNotFound extends Schema.TaggedError<BuildsNotFound>()("BuildsNotFound", {
  commit: Schema.String,
}) {
  override get message(): string {
    return `Buildkite has no build that commit ${this.commit.slice(0, 9)} started, or my account cannot see one`
  }
}

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
  /**
   * How long to wait before asking once more, when Buildkite has no build of a commit. It creates a commit's
   * builds a moment after the commit arrives.
   */
  readonly settle: Duration.Input
}

/** Buildkite's builds, as the gateway reads them. */
export interface Interface {
  /**
   * Reads the builds a commit's arrival on a branch started, and the jobs that failed in each failed one.
   *
   * A build on a schedule is left out: it builds whatever commit is newest at that hour. So is a build on a
   * merge queue's branch, which ran before the commit was merged.
   */
  readonly read: (
    ref: CommitBuildsRef,
  ) => Effect.Effect<CommitBuildsFacts, BuildsNotFound | BuildkiteUnavailable | SignIns.NotSignedIn>
}

/** The gateway's connection to Buildkite. */
export class Service extends Context.Service<Service, Interface>()("@ratchet/gateway/Buildkite") {}

/** What `list_builds` answers for one build. It names no pipeline, and not what started the build. */
const Listed = Schema.Struct({
  id: Schema.String,
  branch: Schema.String,
  state: Schema.String,
  number: Schema.Int,
  message: Schema.NullOr(Schema.String),
  created_at: Schema.DateFromString,
  web_url: Schema.String,
})

type Listed = typeof Listed.Type

const Builds = Schema.Struct({ items: Schema.Array(Listed) })

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
const pipelineOf = (build: Listed): string | undefined => /^https?:\/\/[^/]+\/[^/]+\/([^/]+)\/builds\/\d+/.exec(build.web_url)?.[1]

const hasFailed = (build: Listed) => build.state === "failing" || build.state === "failed"

/** Builds the connection on Buildkite's MCP server. Nothing is sent until a read runs. */
export const make = (config: Config): Effect.Effect<Interface, never, HttpClient.HttpClient | SignIns.Service> =>
  Effect.gen(function* () {
    const buildkite = yield* McpClient.make({ url: config.url, system: "buildkite" })
    // What started a build never changes, and neither do the failed jobs of a build that is over.
    const sources = yield* Ref.make(new Map<string, string>())
    const failures = yield* Ref.make(new Map<string, ReadonlyArray<string>>())
    const organization = { org_slug: config.organization }

    const remembered = <A>(held: Ref.Ref<Map<string, A>>, id: string) =>
      Effect.map(Ref.get(held), (map) => Option.fromUndefinedOr(map.get(id)))

    const remember = <A>(held: Ref.Ref<Map<string, A>>, id: string, value: A) =>
      Ref.update(held, (map) => new Map(map).set(id, value))

    const sourceOf = Effect.fnUntraced(function* (build: Listed, pipeline: string) {
      const known = yield* remembered(sources, build.id)

      if (Option.isSome(known)) return known.value

      const call = { ...organization, pipeline_slug: pipeline, build_number: String(build.number) }
      const { source } = yield* buildkite.call("get_build", call, Shown)
      yield* remember(sources, build.id, source)

      return source
    })

    const failedJobsOf = Effect.fnUntraced(function* (build: Listed, pipeline: string) {
      if (!hasFailed(build)) return []
      const known = yield* remembered(failures, build.id)

      if (Option.isSome(known)) return known.value

      const call = { ...organization, pipeline_slug: pipeline, build_number: String(build.number), state: "failed,timed_out" }
      const jobs = yield* buildkite.call("list_jobs", call, Jobs)
      const names = jobs.items.map((job) => job.step_key ?? job.name ?? "a job without a name")

      // More jobs can fail while a build is failing, so only a failed build's jobs are kept.
      if (build.state === "failed") yield* remember(failures, build.id, names)

      return names
    })

    const listed = (ref: CommitBuildsRef) =>
      Effect.map(buildkite.call("list_builds", { ...organization, commit: ref.commit, per_page: 100 }, Builds), ({ items }) =>
        items.filter((build) => !build.branch.startsWith(mergeQueue)),
      )

    const read = Effect.fn("Buildkite.read")(function* (ref: CommitBuildsRef) {
      yield* Effect.annotateCurrentSpan("buildkite.commit", ref.commit)

      const once = Effect.gen(function* () {
        const started = yield* Effect.forEach(
          yield* listed(ref),
          Effect.fnUntraced(function* (build) {
            const pipeline = pipelineOf(build)

            if (pipeline === undefined || (yield* sourceOf(build, pipeline)) === "schedule") return Option.none()

            const read: Build = {
              id: build.id,
              pipeline,
              number: build.number,
              state: build.state,
              url: build.web_url,
              createdAt: build.created_at.getTime(),
              failedJobs: yield* failedJobsOf(build, pipeline),
            }

            return Option.some({ build: read, message: build.message ?? "" })
          }),
          { concurrency: 4 },
        )

        // The oldest first, so that two reads of the same builds are equal.
        return started
          .flatMap((one) => Option.toArray(one))
          .toSorted((a, b) => a.build.createdAt - b.build.createdAt || a.build.id.localeCompare(b.build.id))
      })

      const first = yield* once
      const started = first.length > 0 ? first : yield* Effect.andThen(Effect.sleep(config.settle), once)
      const oldest = started[0]

      if (oldest === undefined) return yield* new BuildsNotFound({ commit: ref.commit })

      const facts: CommitBuildsFacts = {
        ref: { commit: ref.commit },
        // The oldest build is one the commit's arrival started, so its message is the commit's.
        title: oldest.message.split("\n")[0] ?? "",
        builds: started.map(({ build }) => build),
      }

      return facts
    }, Effect.catchTags({
      McpUnavailable: ({ operation, cause }) => Effect.fail(new BuildkiteUnavailable({ operation, cause })),
      ToolFailed: ({ tool, problem }) => Effect.fail(new BuildkiteUnavailable({ operation: tool, cause: problem })),
    }))

    return Service.of({ read })
  })

/** The connection to Buildkite, still in need of an HTTP client and the gateway's sign-ins. */
export const layerWithoutDependencies = (
  config: Config,
): Layer.Layer<Service, never, HttpClient.HttpClient | SignIns.Service> => Layer.effect(Service, make(config))

/** The connection to Buildkite over `fetch`, still in need of the gateway's sign-ins. */
export const layer = (config: Config): Layer.Layer<Service, never, SignIns.Service> =>
  layerWithoutDependencies(config).pipe(Layer.provide(FetchHttpClient.layer))
