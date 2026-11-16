import { expect, test } from "bun:test"
import { Effect } from "effect"
import { Machine } from "effect-machine"
import type { Build, CommitBuildsFacts } from "../protocol/builds.ts"
import { CommitBuildsEvent, CommitBuildsState, changes, commitBuildsMachine, describe, repeats, settles } from "./commit-builds.ts"

const minute = 60_000
const created = 1_000_000_000
const commit = "ab12".repeat(10)

/** A pipeline's build of the followed commit. `over` changes which build it is, or which commit it built. */
const build = (pipeline: string, state: string, over: Partial<Build> = {}): Build => ({
  id: `${pipeline}-1`,
  pipeline,
  number: 1,
  state,
  url: `https://buildkite.com/lovable/${pipeline}/builds/1`,
  commit,
  createdAt: created,
  failedJobs: [],
  ...over,
})

const facts = (...builds: ReadonlyArray<Build>): CommitBuildsFacts => ({
  ref: { owner: "o", repo: "r", commit },
  title: "Speed up the build (#12)",
  builds,
})

/** What each observation changes, in order, starting from builds nobody has seen. `at` is minutes after the builds were created. */
const observe = (...observations: ReadonlyArray<{ readonly at: number; readonly facts: CommitBuildsFacts }>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      let state: CommitBuildsState = CommitBuildsState.Unseen({ subscribers: [] })
      const all: Array<ReadonlyArray<string>> = []

      for (const observation of observations) {
        const event = CommitBuildsEvent.Observed({ facts: observation.facts, at: created + observation.at * minute })
        const next: CommitBuildsState = yield* Machine.replay(commitBuildsMachine, [event], { from: state })
        all.push(changes(state, next).map(describe))
        state = next
      }

      return all
    }),
  )

const failed = "Build bazel #1 failed in test: https://buildkite.com/lovable/bazel/builds/1"

test("a build that fails is told once, with the jobs that had failed by then, and told again when it passes after a retry", async () => {
  const seen = await observe(
    { at: 1, facts: facts(build("bazel", "running"), build("deploy", "running")) },
    { at: 2, facts: facts(build("bazel", "failing", { failedJobs: ["test"] }), build("deploy", "running")) },
    { at: 3, facts: facts(build("bazel", "failed", { failedJobs: ["test", "lint"] }), build("deploy", "passed")) },
    { at: 4, facts: facts(build("bazel", "passed"), build("deploy", "passed")) },
  )

  expect(seen).toEqual([[], [failed], [], ["Build bazel #1 passed, after the pipeline's build had failed."]])
})

test("a pipeline whose failed build gives way to another is told when that one fails, and when one passes at last", async () => {
  const rebuild = { id: "bazel-2", number: 2, url: "https://buildkite.com/lovable/bazel/builds/2" }

  const seen = await observe(
    { at: 1, facts: facts(build("bazel", "failed", { failedJobs: ["test"] })) },
    { at: 2, facts: facts(build("bazel", "running", rebuild)) },
    { at: 3, facts: facts(build("bazel", "failed", { ...rebuild, failedJobs: ["test"] })) },
    { at: 4, facts: facts(build("bazel", "passed", { id: "bazel-3", number: 3 })) },
  )

  expect(seen).toEqual([
    [failed],
    [],
    ["Build bazel #2 failed in test: https://buildkite.com/lovable/bazel/builds/2"],
    ["Build bazel #3 passed, after the pipeline's build had failed."],
  ])
})

test("a failed build of a later commit is told as carrying other changes too", async () => {
  const seen = await observe({ at: 1, facts: facts(build("bazel", "failed", { commit: "cd34".repeat(10) })) })

  expect(seen).toEqual([
    [
      "Build bazel #1 failed: https://buildkite.com/lovable/bazel/builds/1 It built a later commit, so it carries other changes as well as this one.",
    ],
  ])
})

test("the builds settle once all are over for a quarter of an hour, and are stored once more when they do", async () => {
  const over = facts(build("bazel", "failed", { failedJobs: ["test"] }), build("deploy", "canceled"))

  const seen = await observe({ at: 5, facts: over }, { at: 14, facts: over }, { at: 15, facts: over })
  expect(seen).toEqual([[failed], [], ["Every build is over. 1 failed."]])

  const building = CommitBuildsState.Building({ commit, title: over.title, builds: over.builds, unrecovered: ["bazel"], subscribers: [] })
  expect(repeats(building, over, created + 14 * minute)).toBe(true)
  expect(repeats(building, over, created + 15 * minute)).toBe(false)
})

test("a build that never ends does not keep the builds followed for more than a day", () => {
  const waiting = [build("deploy", "blocked")]

  expect(settles(waiting, created + 23 * 60 * minute)).toBe(false)
  expect(settles(waiting, created + 24 * 60 * minute)).toBe(true)
  expect(settles([], created + 48 * 60 * minute)).toBe(false)
})
