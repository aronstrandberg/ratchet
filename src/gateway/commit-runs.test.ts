import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import * as CommitRuns from "./commit-runs.ts"
import * as GitHub from "./github.ts"
import * as Spacelift from "./spacelift.ts"

const hash = (letter: string) => letter.repeat(40)
const ref = { owner: "o", repo: "r", commit: hash("a") }

/** A tracked run as Spacelift lists it. */
const run = (stack: string, number: number, state: string, commit: string): Spacelift.Listed => ({
  id: `${stack}-${number}`,
  stack,
  state,
  needsApproval: false,
  url: `https://spacelift.test/stack/${stack}/run/${stack}-${number}`,
  commit,
  createdAt: number * 1000,
  updatedAt: number * 1000,
  delta: null,
})

/**
 * The reading on a branch and its runs as a test gives them: `branch` is the commits from the followed one
 * onward, `planned` the stacks that planned the pull request, and `runs` every tracked run Spacelift holds.
 */
const reading = (branch: ReadonlyArray<string>, planned: ReadonlyArray<string>, runs: ReadonlyArray<Spacelift.Listed>) => {
  const github = Layer.succeed(
    GitHub.Service,
    GitHub.Service.of({
      read: (pullRequest) => Effect.fail(new GitHub.PullRequestNotFound(pullRequest)),
      landing: () => Effect.succeed({ title: "Give the role a binding (#12)", branch: "main", proposed: [hash("p")], commits: branch }),
    }),
  )

  const spacelift = Layer.succeed(
    Spacelift.Service,
    Spacelift.Service.of({
      planned: (commits) => Effect.succeed(commits.includes(hash("p")) ? planned : []),
      tracked: (stacks, commits) =>
        Effect.succeed(runs.filter((held) => stacks.includes(held.stack) && commits.includes(held.commit))),
    }),
  )

  return CommitRuns.layerWithoutDependencies({ settle: 0 }).pipe(Layer.provide(Layer.mergeAll(github, spacelift)))
}

const read = Effect.flatMap(CommitRuns.Service, (runs) => runs.read(ref))

/** What a read answers, as `run state` for each stack's run. */
const carried = Effect.map(read, (facts) => facts.runs.map((held) => `${held.id} ${held.state}`))

test("the runs of a commit are those of the stacks that planned its pull request, and not every stack its push started", async () => {
  const runs = [run("iam", 1, "UNCONFIRMED", hash("b")), run("dns", 2, "FINISHED", hash("b")), run("billing", 3, "UNCONFIRMED", hash("b"))]
  const facts = await Effect.runPromise(read.pipe(Effect.provide(reading([hash("a"), hash("b")], ["dns", "iam"], runs))))

  expect(facts).toEqual({ ref, title: "Give the role a binding (#12)", runs: [run("dns", 2, "FINISHED", hash("b")), run("iam", 1, "UNCONFIRMED", hash("b"))] })
})

test("a stack's run that was started again and skipped does not hide the run that waits", async () => {
  const runs = [run("iam", 1, "UNCONFIRMED", hash("a")), run("iam", 2, "SKIPPED", hash("a")), run("iam", 3, "SKIPPED", hash("a"))]

  expect(await Effect.runPromise(carried.pipe(Effect.provide(reading([hash("a")], ["iam"], runs))))).toEqual(["iam-1 UNCONFIRMED"])
})

test("a stack that skipped the commit is carried by its run of a later commit, and a failed run by its retry", async () => {
  const runs = [
    run("iam", 1, "SKIPPED", hash("a")),
    run("iam", 2, "FAILED", hash("b")),
    run("iam", 3, "APPLYING", hash("b")),
    run("iam", 4, "FINISHED", hash("c")),
    run("dns", 5, "SKIPPED", hash("a")),
  ]

  expect(await Effect.runPromise(carried.pipe(Effect.provide(reading([hash("a"), hash("b"), hash("c")], ["dns", "iam"], runs))))).toEqual([
    "dns-5 SKIPPED",
    "iam-3 APPLYING",
  ])
})

test("a pull request that no stack planned, and one whose stacks have no run yet, have no runs to follow", async () => {
  const unplanned = Effect.flip(read).pipe(Effect.provide(reading([hash("a")], [], [run("iam", 1, "UNCONFIRMED", hash("a"))])))
  const early = Effect.flip(read).pipe(Effect.provide(reading([hash("a")], ["iam"], [])))

  expect(await Effect.runPromise(unplanned)).toBeInstanceOf(CommitRuns.NoRuns)
  expect(await Effect.runPromise(early)).toBeInstanceOf(CommitRuns.NoRuns)
})
