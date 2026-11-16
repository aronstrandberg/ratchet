import { Clock, Context, Duration, Effect, Layer, Ref, Schema } from "effect"
import type { Build, CommitBuildsFacts, CommitBuildsRef } from "../protocol/builds.ts"
import * as Buildkite from "./buildkite.ts"
import * as GitHub from "./github.ts"
import type * as SignIns from "./sign-ins.ts"

/** No build carries the commit: its repository has no CI, or the builds do not exist yet. */
export class NoBuilds extends Schema.TaggedError<NoBuilds>()("NoBuilds", {
  commit: Schema.String,
}) {
  override get message(): string {
    return `no build carries commit ${this.commit.slice(0, 9)}`
  }
}

/** How patient a read is. */
export interface Config {
  /**
   * How long to wait before looking once more, when no build carries a commit. The CI system creates a
   * push's builds a moment after the push.
   */
  readonly settle: Duration.Input
  /** How long the builds of one commit are kept, so that the commits read in one round share what they ask. */
  readonly fresh: Duration.Input
}

type Failure =
  | NoBuilds
  | GitHub.CommitNotMerged
  | GitHub.GitHubUnavailable
  | Buildkite.BuildkiteUnavailable
  | SignIns.NotSignedIn

/** The builds that carry a commit, read from GitHub and Buildkite together. */
export interface Interface {
  /**
   * Reads the builds that carry a merge commit: one for each pipeline that the push which brought the commit
   * onto its branch started.
   *
   * A branch gets several commits in one push, and only the last is built. A pipeline skips a build when a
   * newer one is waiting. So this walks the branch from the commit onward, and takes for each pipeline the
   * first build that was not skipped or canceled. While there is none, the latest skipped one stands for the
   * pipeline. A build on a schedule is passed over.
   */
  readonly read: (ref: CommitBuildsRef) => Effect.Effect<CommitBuildsFacts, Failure>
}

/** The gateway's reading of the builds that carry a commit. */
export class Service extends Context.Service<Service, Interface>()("@ratchet/gateway/CommitBuilds") {}

/** The states of a build that did not run to an end of its own: a later build carries what it would have. */
const superseded = new Set(["skipped", "canceled", "not_run"])
const isSuperseded = (build: Buildkite.Listed) => superseded.has(build.state)

/** How many commits are asked about at once. */
const abreast = 6

/** Builds the reading on the gateway's connections to GitHub and Buildkite. */
export const make = (config: Config): Effect.Effect<Interface, never, GitHub.Service | Buildkite.Service> =>
  Effect.gen(function* () {
    const github = yield* GitHub.Service
    const buildkite = yield* Buildkite.Service
    // A commit without a build, before a commit that has one, was not the last of its push. It never gets one.
    const midPush = yield* Ref.make(new Set<string>())
    const recent = yield* Ref.make(new Map<string, { readonly at: number; readonly builds: ReadonlyArray<Buildkite.Listed> }>())

    const buildsOf = Effect.fnUntraced(function* (commit: string) {
      const now = yield* Clock.currentTimeMillis
      const held = (yield* Ref.get(recent)).get(commit)

      if (held !== undefined && now - held.at < Duration.toMillis(config.fresh)) return held.builds

      const builds = yield* buildkite.buildsOf(commit)

      yield* Ref.update(recent, (map) => {
        const kept = [...map].filter(([, entry]) => now - entry.at < Duration.toMillis(config.fresh))

        return new Map(kept).set(commit, { at: now, builds })
      })

      return builds
    })

    const startedByPush = (builds: ReadonlyArray<Buildkite.Listed>) =>
      Effect.filter(builds, (build) => Effect.map(buildkite.scheduled(build), (scheduled) => !scheduled), { concurrency: abreast })

    /** The build that carries the commit in each pipeline, or none when no push that held the commit was built. */
    const carrying = Effect.fnUntraced(function* (commits: ReadonlyArray<string>) {
      const known = yield* Ref.get(midPush)
      const walk = commits.filter((commit) => !known.has(commit))
      const picked = new Map<string, Buildkite.Listed>()
      const unbuilt: Array<string> = []
      let pipelines: ReadonlyArray<string> | undefined

      const waiting = () =>
        pipelines?.filter((pipeline) => {
          const build = picked.get(pipeline)

          return build === undefined || isSuperseded(build)
        })

      for (let start = 0; start < walk.length && waiting()?.length !== 0; start += abreast) {
        const listed = yield* Effect.forEach(walk.slice(start, start + abreast), buildsOf, { concurrency: abreast })

        for (const [offset, builds] of listed.entries()) {
          const commit = walk[start + offset]

          if (commit === undefined || builds.length === 0) {
            if (commit !== undefined) unbuilt.push(commit)
            continue
          }

          // A later commit has builds, so the pushes of the commits before it are all built by now.
          const passed = unbuilt.splice(0)
          yield* Ref.update(midPush, (held) => new Set([...held, ...passed]))

          const open = waiting()
          const candidates = open === undefined ? builds : builds.filter((build) => open.includes(build.pipeline))
          const started = yield* startedByPush(candidates)

          // The first commit that a push built names the pipelines to follow.
          pipelines ??= started.length === 0 ? undefined : [...new Set(started.map((build) => build.pipeline))].toSorted()

          // The builds are listed oldest first, so a pipeline's rebuild replaces the build before it.
          for (const build of started) picked.set(build.pipeline, build)
        }
      }

      return (pipelines ?? []).flatMap((pipeline) => {
        const build = picked.get(pipeline)

        return build === undefined ? [] : [build]
      })
    })

    const read = Effect.fn("CommitBuilds.read")(function* (ref: CommitBuildsRef) {
      const landing = yield* github.landing(ref)
      const first = yield* carrying(landing.commits)
      const found = first.length > 0 ? first : yield* Effect.andThen(Effect.sleep(config.settle), carrying(landing.commits))

      if (found.length === 0) return yield* new NoBuilds({ commit: ref.commit })

      const builds = yield* Effect.forEach(
        found,
        (build): Effect.Effect<Build, Buildkite.BuildkiteUnavailable | SignIns.NotSignedIn> =>
          Effect.map(buildkite.failedJobs(build), (failedJobs) => ({ ...build, failedJobs })),
        { concurrency: abreast },
      )

      const facts: CommitBuildsFacts = { ref, title: landing.title, builds }

      return facts
    })

    return Service.of({ read })
  })

/** The reading, still in need of the gateway's connections to GitHub and Buildkite. */
export const layerWithoutDependencies = (config: Config): Layer.Layer<Service, never, GitHub.Service | Buildkite.Service> =>
  Layer.effect(Service, make(config))
