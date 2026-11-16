import { Equal, Schema } from "effect"
import { Event, Machine, State } from "effect-machine"
import { toEntity } from "effect-machine/cluster"
import { Build, CommitBuildsFacts } from "../protocol/builds.ts"
import { TaskId } from "../protocol/ids.ts"
import type { Outcome, Relation } from "../protocol/resource.ts"
import { Subscriber, attach, detach } from "./subscribers.ts"

const subscribers = { subscribers: Schema.Array(Subscriber) }

const seen = {
  /** The commit whose builds these are. A build that built another commit carries later commits as well. */
  commit: Schema.String,
  title: Schema.String,
  builds: Schema.Array(Build),
  /** The pipelines whose build failed and that have had no build pass since. */
  unrecovered: Schema.Array(Schema.String),
  ...subscribers,
}

/**
 * What the hub holds about the builds that carry a commit: what the CI system last said, and who follows
 * them.
 *
 * `Building` while a build may still start, finish or be retried. `Settled` once they are all over: nothing
 * reads them after that.
 */
export const CommitBuildsState = State({
  Unseen: subscribers,
  Building: seen,
  Settled: seen,
})

/** The state of a commit's builds, in any of its tags. */
export type CommitBuildsState = typeof CommitBuildsState.Type

/** What can happen to the builds of a commit as the hub sees it. */
export const CommitBuildsEvent = Event({
  /** `at` is when the hub took the observation, in milliseconds since the epoch. */
  Observed: { facts: CommitBuildsFacts, at: Schema.Number },
  Attached: { subscriber: Subscriber },
  Detached: { task: TaskId },
})

/**
 * How long after the newest build was created every build must have been over, before the builds are settled.
 * A pipeline that skips its builds while one runs has a new build with each push, so the wait starts again.
 */
const quietFor = 15 * 60_000

/** How long after the newest build was created the hub stops following builds that never finish. */
const giveUpAfter = 24 * 60 * 60_000

const over = new Set(["passed", "failed", "canceled", "skipped", "not_run"])
const isOver = (build: Build) => over.has(build.state)
const hasFailed = (build: Build) => build.state === "failing" || build.state === "failed"

/**
 * Whether the builds of a commit are settled at a moment.
 *
 * They are once every build has been over for a while: a commit's arrival starts builds that start others,
 * and a failed build is often retried. A build that waits for a person never ends, so after a day they are
 * settled whatever their state.
 */
export const settles = (builds: ReadonlyArray<Build>, at: number): boolean => {
  if (builds.length === 0) return false
  const age = at - Math.max(...builds.map((build) => build.createdAt))

  return age >= giveUpAfter || (age >= quietFor && builds.every(isOver))
}

const any = [CommitBuildsState.Unseen, CommitBuildsState.Building, CommitBuildsState.Settled] as const
const isUnseen = CommitBuildsState.$is("Unseen")
const isSettled = CommitBuildsState.$is("Settled")
const unrecoveredOf = (state: CommitBuildsState): ReadonlyArray<string> => (isUnseen(state) ? [] : state.unrecovered)

/** How the state of a commit's builds follows from what happens to them. */
export const commitBuildsMachine = Machine.make({
  state: CommitBuildsState,
  event: CommitBuildsEvent,
  initial: CommitBuildsState.Unseen({ subscribers: [] }),
})
  .on(any, CommitBuildsEvent.Observed, ({ state, event }) => {
    const { ref, title, builds } = event.facts
    const passed = new Set(builds.filter((build) => build.state === "passed").map((build) => build.pipeline))
    const failed = builds.filter(hasFailed).map((build) => build.pipeline)
    const unrecovered = [...new Set([...unrecoveredOf(state), ...failed])].filter((pipeline) => !passed.has(pipeline))
    const held = { commit: ref.commit, title, builds, unrecovered, subscribers: state.subscribers }

    return settles(event.facts.builds, event.at) ? CommitBuildsState.Settled(held) : CommitBuildsState.Building(held)
  })
  .on(any, CommitBuildsEvent.Attached, ({ state, event }) =>
    CommitBuildsState.with(state, { subscribers: attach(state.subscribers, event.subscriber) }),
  )
  .on(any, CommitBuildsEvent.Detached, ({ state, event }) =>
    CommitBuildsState.with(state, { subscribers: detach(state.subscribers, event.task) }),
  )

/** The builds of a commit as a cell: one per commit. */
export const CommitBuildsEntity = toEntity(commitBuildsMachine, { type: "CommitBuilds" })

/** Something that happened to the builds of a commit, in terms a task can act on. */
export const Change = Schema.TaggedUnion({
  /**
   * A pipeline's build has a failed job. It is told once for a build, when the first job fails. `shared` says
   * that the build built a later commit, so it carries other people's changes as well.
   */
  BuildFailed: {
    pipeline: Schema.String,
    number: Schema.Int,
    jobs: Schema.Array(Schema.String),
    url: Schema.String,
    shared: Schema.Boolean,
  },
  /** A pipeline whose build had failed has a build that passed: the same one after a retry, or a later one. */
  BuildRecovered: { pipeline: Schema.String, number: Schema.Int },
  /** Every build is over. `failed` is how many of them failed. */
  Settled: { failed: Schema.Int },
})

/** One thing that happened to the builds of a commit. */
export type Change = typeof Change.Type

/** The builds a state holds. None before the first observation. */
export const buildsOf = (state: CommitBuildsState): ReadonlyArray<Build> => (isUnseen(state) ? [] : state.builds)

/**
 * Whether an observation says nothing the cell does not hold already, so that it need not be stored again.
 *
 * The same builds are worth storing once more when they settle, which the passing of time alone brings about.
 */
export const repeats = (state: CommitBuildsState, facts: CommitBuildsFacts, at: number): boolean => {
  if (isUnseen(state)) return false

  if (isSettled(state)) return true

  return state.title === facts.title && Equal.equals(state.builds, facts.builds) && !settles(facts.builds, at)
}

/** How the builds ended, or null while one may still change. */
export const outcomeOf = (state: CommitBuildsState): Outcome | null => (isSettled(state) ? "completed" : null)

/**
 * What changed between two observations of a commit's builds.
 *
 * A pipeline has one build at a time, and which build that is can change: a build that was canceled gives way
 * to the next one, and a failed build to its rebuild. So the two observations are compared pipeline by
 * pipeline. Unlike other kinds of resource, the first observation reports a build that has failed already:
 * the hub follows a merged pull request's builds itself, so no session reads their state when they are
 * attached.
 */
export const changes = (before: CommitBuildsState, after: CommitBuildsState): ReadonlyArray<Change> => {
  if (isUnseen(after)) return []
  const found: Array<Change> = []
  const known = new Map(buildsOf(before).map((build) => [build.pipeline, build]))

  for (const build of after.builds) {
    const earlier = known.get(build.pipeline)
    const failedBefore = earlier !== undefined && hasFailed(earlier)

    if (hasFailed(build) && !(failedBefore && earlier.id === build.id)) {
      const { pipeline, number, url } = build
      const shared = build.commit !== after.commit
      found.push(Change.cases.BuildFailed.make({ pipeline, number, jobs: build.failedJobs, url, shared }))
    }

    if (build.state === "passed" && unrecoveredOf(before).includes(build.pipeline)) {
      found.push(Change.cases.BuildRecovered.make({ pipeline: build.pipeline, number: build.number }))
    }
  }

  if (isSettled(after) && !isSettled(before)) {
    found.push(Change.cases.Settled.make({ failed: after.builds.filter(hasFailed).length }))
  }

  return found
}

const isAboutFailure = Change.isAnyOf(["BuildFailed", "BuildRecovered"])

/**
 * Whether a change should wake a session of a task with this relation to the builds.
 *
 * An owner hears a build fail, and hears it pass after all. That every build is over wakes nobody: most
 * commits pass, and a session whose work is done has nothing to do about it.
 */
export const wakes = (relation: Relation, change: Change): boolean => relation === "owns" && isAboutFailure(change)

/** One line a session can read, for one change. */
export const describe = (change: Change): string =>
  Change.match(change, {
    BuildFailed: ({ pipeline, number, jobs, url, shared }) =>
      [
        `Build ${pipeline} #${number} failed${jobs.length === 0 ? "" : ` in ${jobs.join(", ")}`}: ${url}`,
        ...(shared ? ["It built a later commit, so it carries other changes as well as this one."] : []),
      ].join(" "),
    BuildRecovered: ({ pipeline, number }) => `Build ${pipeline} #${number} passed, after the pipeline's build had failed.`,
    Settled: ({ failed }) => (failed === 0 ? "Every build is over, and none failed." : `Every build is over. ${failed} failed.`),
  })

/** Where the builds stand, in a few words: how many are in each state, the failed ones first. */
export const summaryOf = (state: CommitBuildsState): string => {
  if (isUnseen(state)) return "unseen"
  const counts = new Map<string, number>()

  for (const build of state.builds) {
    const word = hasFailed(build) ? "failed" : isOver(build) ? build.state : "running"
    counts.set(word, (counts.get(word) ?? 0) + 1)
  }

  // What needs attention comes first, and the states a build ends in without failing come last.
  const first = ["failed", "running", "passed"].filter((word) => counts.has(word))
  const rest = [...counts.keys()].filter((word) => !first.includes(word))

  return [...first, ...rest].map((word) => `${counts.get(word)} ${word}`).join(", ")
}

/** The pipelines whose build of the commit has failed. */
export const failedPipelines = (state: CommitBuildsState): ReadonlyArray<string> =>
  buildsOf(state)
    .filter(hasFailed)
    .map((build) => build.pipeline)
