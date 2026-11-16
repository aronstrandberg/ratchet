import { expect, test } from "bun:test"
import { Effect } from "effect"
import { Machine } from "effect-machine"
import type { Build, CommitBuildsFacts } from "../protocol/builds.ts"
import { CommitBuildsEvent, CommitBuildsState, changes, commitBuildsMachine, describe, repeats, settles } from "./commit-builds.ts"

const minute = 60_000
const created = 1_000_000_000

const build = (pipeline: string, state: string, failedJobs: ReadonlyArray<string> = []): Build => ({
  id: `${pipeline}-1`,
  pipeline,
  number: 1,
  state,
  url: `https://buildkite.com/lovable/${pipeline}/builds/1`,
  createdAt: created,
  failedJobs,
})

const facts = (...builds: ReadonlyArray<Build>): CommitBuildsFacts => ({
  ref: { commit: "ab12".repeat(10) },
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

test("a build that fails is told once, with the jobs that had failed by then, and told again when it passes after a retry", async () => {
  const seen = await observe(
    { at: 1, facts: facts(build("bazel", "running"), build("deploy", "running")) },
    { at: 2, facts: facts(build("bazel", "failing", ["test"]), build("deploy", "running")) },
    { at: 3, facts: facts(build("bazel", "failed", ["test", "lint"]), build("deploy", "passed")) },
    { at: 4, facts: facts(build("bazel", "passed"), build("deploy", "passed")) },
  )

  expect(seen).toEqual([
    [],
    ["Build bazel #1 failed in test: https://buildkite.com/lovable/bazel/builds/1"],
    [],
    ["Build bazel #1 passed after all."],
  ])
})

test("a build that had failed before the first observation is told then, because no session read it", async () => {
  const seen = await observe({ at: 1, facts: facts(build("bazel", "failed")) })

  expect(seen).toEqual([["Build bazel #1 failed: https://buildkite.com/lovable/bazel/builds/1"]])
})

test("the builds settle once all are over for a quarter of an hour, and are stored once more when they do", async () => {
  const over = facts(build("bazel", "failed", ["test"]), build("deploy", "canceled"))

  const seen = await observe({ at: 5, facts: over }, { at: 14, facts: over }, { at: 15, facts: over })
  expect(seen).toEqual([["Build bazel #1 failed in test: https://buildkite.com/lovable/bazel/builds/1"], [], ["Every build is over. 1 failed."]])

  const building = CommitBuildsState.Building({ title: over.title, builds: over.builds, subscribers: [] })
  expect(repeats(building, over, created + 14 * minute)).toBe(true)
  expect(repeats(building, over, created + 15 * minute)).toBe(false)
})

test("a build that never ends does not keep the builds followed for more than a day", () => {
  const waiting = [build("deploy", "blocked")]

  expect(settles(waiting, created + 23 * 60 * minute)).toBe(false)
  expect(settles(waiting, created + 24 * 60 * minute)).toBe(true)
  expect(settles([], created + 48 * 60 * minute)).toBe(false)
})
