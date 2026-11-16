import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import * as Buildkite from "./buildkite.ts"
import * as CommitBuilds from "./commit-builds.ts"
import * as GitHub from "./github.ts"

const hash = (letter: string) => letter.repeat(40)
const ref = { owner: "o", repo: "r", commit: hash("a") }

/** A build as Buildkite lists it. A build with `scheduled` in its ID was started by a schedule. */
const build = (pipeline: string, number: number, state: string, commit: string, id = `${pipeline}-${number}`): Buildkite.Listed => ({
  id,
  pipeline,
  number,
  state,
  url: `https://buildkite.com/lovable/${pipeline}/builds/${number}`,
  commit,
  createdAt: number * 1000,
})

/**
 * The reading on a branch and its builds as a test gives them: `branch` is the commits from the followed one
 * onward, and `builds` what Buildkite holds, which a test changes between two reads. `asked` collects the
 * commits Buildkite was asked about.
 */
const reading = (branch: ReadonlyArray<string>, builds: { current: ReadonlyArray<Buildkite.Listed> }, asked: Array<string> = []) => {
  const github = Layer.succeed(
    GitHub.Service,
    GitHub.Service.of({
      read: (pullRequest) => Effect.fail(new GitHub.PullRequestNotFound(pullRequest)),
      landing: () => Effect.succeed({ title: "Speed up the build (#12)", branch: "main", commits: branch }),
    }),
  )

  const buildkite = Layer.succeed(
    Buildkite.Service,
    Buildkite.Service.of({
      buildsOf: (commit) =>
        Effect.sync(() => {
          asked.push(commit)

          return builds.current.filter((held) => held.commit === commit)
        }),
      scheduled: (held) => Effect.succeed(held.id.includes("scheduled")),
      failedJobs: (held) => Effect.succeed(held.state === "failed" ? ["test"] : []),
    }),
  )

  return CommitBuilds.layerWithoutDependencies({ settle: 0, fresh: 0 }).pipe(Layer.provide(Layer.mergeAll(github, buildkite)))
}

const read = Effect.flatMap(CommitBuilds.Service, (builds) => builds.read(ref))

/** What a read answers, as `pipeline #number state` for each build. */
const carried = Effect.map(read, (facts) => facts.builds.map((held) => `${held.pipeline} #${held.number} ${held.state}`))

test("a commit that came in a push with later commits is carried by the builds of the push's last commit", async () => {
  const builds = { current: [build("bazel", 1, "failed", hash("c")), build("deploy", 2, "running", hash("c"))] }
  const facts = await Effect.runPromise(read.pipe(Effect.provide(reading([hash("a"), hash("b"), hash("c")], builds))))

  expect(facts).toEqual({
    ref,
    title: "Speed up the build (#12)",
    builds: [
      { ...build("bazel", 1, "failed", hash("c")), failedJobs: ["test"] },
      { ...build("deploy", 2, "running", hash("c")), failedJobs: [] },
    ],
  })
})

test("a pipeline that skipped its build is carried by its next build that ran, and by the latest skipped one until then", async () => {
  const builds = {
    current: [
      build("bazel", 1, "passed", hash("a")),
      build("deploy", 2, "skipped", hash("a")),
      // The pipeline that is carried already is not followed further.
      build("bazel", 3, "failed", hash("b")),
      build("deploy", 4, "canceled", hash("b")),
    ],
  }

  const [waiting, running] = await Effect.runPromise(
    Effect.gen(function* () {
      const waiting = yield* carried
      builds.current = [...builds.current, build("deploy", 5, "running", hash("c")), build("deploy", 6, "running", hash("d"))]

      return [waiting, yield* carried]
    }).pipe(Effect.provide(reading([hash("a"), hash("b"), hash("c"), hash("d")], builds))),
  )

  expect(waiting).toEqual(["bazel #1 passed", "deploy #4 canceled"])
  expect(running).toEqual(["bazel #1 passed", "deploy #5 running"])
})

test("a build on a schedule carries nothing, and a pipeline that only runs on a schedule is not followed", async () => {
  const builds = {
    current: [
      build("bazel", 1, "skipped", hash("a")),
      build("nightly", 2, "failed", hash("a"), "nightly-scheduled"),
      build("bazel", 3, "failed", hash("b"), "bazel-scheduled"),
      build("bazel", 4, "passed", hash("c")),
    ],
  }

  expect(await Effect.runPromise(carried.pipe(Effect.provide(reading([hash("a"), hash("b"), hash("c")], builds))))).toEqual([
    "bazel #4 passed",
  ])
})

test("a rebuild of a pipeline's build takes its place", async () => {
  const builds = { current: [build("bazel", 1, "failed", hash("a")), build("bazel", 2, "running", hash("a"))] }

  expect(await Effect.runPromise(carried.pipe(Effect.provide(reading([hash("a")], builds))))).toEqual(["bazel #2 running"])
})

test("a commit in the middle of a push is asked about once, and the commits that are built each time", async () => {
  const builds = { current: [build("bazel", 1, "running", hash("b"))] }
  const asked: Array<string> = []

  await Effect.runPromise(
    Effect.andThen(carried, carried).pipe(Effect.provide(reading([hash("a"), hash("b"), hash("c")], builds, asked))),
  )

  // The second read stops at the commit that carries every pipeline, as the first did, and skips the one before it.
  expect(asked.filter((commit) => commit === hash("a"))).toHaveLength(1)
  expect(asked.filter((commit) => commit === hash("b"))).toHaveLength(2)
})

test("a commit that no build carries is not found", async () => {
  const failure = await Effect.runPromise(Effect.flip(read).pipe(Effect.provide(reading([hash("a"), hash("b")], { current: [] }))))

  expect(failure).toBeInstanceOf(CommitBuilds.NoBuilds)
})
