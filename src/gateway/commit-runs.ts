import { Context, type Duration, Effect, Layer, Ref, Schema } from "effect"
import type { CommitRunsFacts, CommitRunsRef } from "../protocol/runs.ts"
import * as GitHub from "./github.ts"
import type * as SignIns from "./sign-ins.ts"
import * as Spacelift from "./spacelift.ts"

/** No infrastructure run carries the commit: no stack planned its pull request, or the runs do not exist yet. */
export class NoRuns extends Schema.TaggedError<NoRuns>()("NoRuns", {
  commit: Schema.String,
}) {
  override get message(): string {
    return `no Spacelift run carries commit ${this.commit.slice(0, 9)}`
  }
}

/** How patient a read is. */
export interface Config {
  /**
   * How long to wait before looking once more, when stacks planned the pull request and none has a run for
   * the merge yet. Spacelift creates a push's runs a moment after the push.
   */
  readonly settle: Duration.Input
}

type Failure =
  | NoRuns
  | GitHub.CommitNotMerged
  | GitHub.GitHubUnavailable
  | Spacelift.SpaceliftUnavailable
  | SignIns.NotSignedIn

/** The infrastructure runs that carry a commit, read from GitHub and Spacelift together. */
export interface Interface {
  /**
   * Reads the runs that carry a merge commit: one for each stack that planned its pull request.
   *
   * A push to a branch starts a run on every stack it touches, and that run is of the push's last commit. So
   * asking for the runs of every stack at the merge commit would hold runs of other people's changes. The
   * stacks that planned the pull request before it merged are the ones its change touches. For each of them
   * this takes the first tracked run that was not skipped, on the commit or on a later commit of the
   * branch. While there is none, the latest skipped one stands for the stack.
   */
  readonly read: (ref: CommitRunsRef) => Effect.Effect<CommitRunsFacts, Failure>
}

/** The gateway's reading of the infrastructure runs that carry a commit. */
export class Service extends Context.Service<Service, Interface>()("@ratchet/gateway/CommitRuns") {}

const isSkipped = (run: Spacelift.Listed) => run.state === "SKIPPED"

/**
 * The run that carries a commit on a stack, out of the stack's runs for the commit and the commits after it.
 * `order` gives each commit's place on the branch.
 */
const carrying = (runs: ReadonlyArray<Spacelift.Listed>, order: ReadonlyMap<string, number>): Spacelift.Listed | undefined => {
  const placed = runs.toSorted(
    (a, b) => (order.get(a.commit) ?? 0) - (order.get(b.commit) ?? 0) || a.createdAt - b.createdAt || a.id.localeCompare(b.id),
  )

  const first = placed.find((run) => !isSkipped(run))

  // A run that failed or was retried gives way to the stack's next run of the same commit.
  return first === undefined ? placed.at(-1) : placed.findLast((run) => !isSkipped(run) && run.commit === first.commit)
}

/** Builds the reading on the gateway's connections to GitHub and Spacelift. */
export const make = (config: Config): Effect.Effect<Interface, never, GitHub.Service | Spacelift.Service> =>
  Effect.gen(function* () {
    const github = yield* GitHub.Service
    const spacelift = yield* Spacelift.Service
    // The stacks that planned a pull request do not change once it has merged.
    const planned = yield* Ref.make(new Map<string, ReadonlyArray<string>>())

    const stacksOf = Effect.fnUntraced(function* (ref: CommitRunsRef, proposed: ReadonlyArray<string>) {
      const known = (yield* Ref.get(planned)).get(ref.commit)

      if (known !== undefined) return known

      const stacks = yield* spacelift.planned(proposed)

      if (stacks.length > 0) yield* Ref.update(planned, (held) => new Map(held).set(ref.commit, stacks))

      return stacks
    })

    const read = Effect.fn("CommitRuns.read")(function* (ref: CommitRunsRef) {
      const landing = yield* github.landing(ref)
      const stacks = yield* stacksOf(ref, landing.proposed)

      if (stacks.length === 0) return yield* new NoRuns({ commit: ref.commit })

      const order = new Map(landing.commits.map((commit, place) => [commit, place]))
      const tracked = spacelift.tracked(stacks, landing.commits)
      const first = yield* tracked
      const found = first.length > 0 ? first : yield* Effect.andThen(Effect.sleep(config.settle), tracked)

      const runs = stacks.flatMap((stack) => {
        const run = carrying(
          found.filter((held) => held.stack === stack),
          order,
        )

        return run === undefined ? [] : [run]
      })

      if (runs.length === 0) return yield* new NoRuns({ commit: ref.commit })

      const facts: CommitRunsFacts = { ref, title: landing.title, runs }

      return facts
    })

    return Service.of({ read })
  })

/** The reading, still in need of the gateway's connections to GitHub and Spacelift. */
export const layerWithoutDependencies = (config: Config): Layer.Layer<Service, never, GitHub.Service | Spacelift.Service> =>
  Layer.effect(Service, make(config))
