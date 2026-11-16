import { Equal, Schema } from "effect"
import { Event, Machine, State } from "effect-machine"
import { toEntity } from "effect-machine/cluster"
import { TaskId } from "../protocol/ids.ts"
import type { Outcome, Relation } from "../protocol/resource.ts"
import { CommitRunsFacts, Run } from "../protocol/runs.ts"
import { Subscriber, attach, detach } from "./subscribers.ts"

const subscribers = { subscribers: Schema.Array(Subscriber) }

const seen = {
  title: Schema.String,
  runs: Schema.Array(Run),
  /** The stacks whose run a session was told about, because it waited or failed, and that have not finished since. */
  told: Schema.Array(Schema.String),
  ...subscribers,
}

/**
 * What the hub holds about the infrastructure runs that carry a commit: what Spacelift last said, and who
 * follows them.
 *
 * `Running` while a run may still plan, wait for someone, apply or be retried. `Settled` once they are all
 * over: nothing reads them after that.
 */
export const CommitRunsState = State({
  Unseen: subscribers,
  Running: seen,
  Settled: seen,
})

/** The state of a commit's runs, in any of its tags. */
export type CommitRunsState = typeof CommitRunsState.Type

/** What can happen to the runs of a commit as the hub sees it. */
export const CommitRunsEvent = Event({
  /** `at` is when the hub took the observation, in milliseconds since the epoch. */
  Observed: { facts: CommitRunsFacts, at: Schema.Number },
  Attached: { subscriber: Subscriber },
  Detached: { task: TaskId },
})

/** How long every run must have been over, counted from the last change to any of them, before the runs are settled. */
const quietFor = 15 * 60_000

/** How long after the newest run was created the hub stops following runs that nobody confirms. */
const giveUpAfter = 7 * 24 * 60 * 60_000

const over = new Set(["FINISHED", "FAILED", "DISCARDED", "CANCELED", "STOPPED", "SKIPPED"])
const dropped = new Set(["DISCARDED", "CANCELED", "STOPPED"])
const isOver = (run: Run) => over.has(run.state)
const hasFailed = (run: Run) => run.state === "FAILED"
const isDropped = (run: Run) => dropped.has(run.state)

/**
 * Whether a run waits for a person: its plan is ready and someone has to confirm it, or a policy asks for an
 * approval before it goes on.
 */
export const waits = (run: Run): boolean => !isOver(run) && (run.state === "UNCONFIRMED" || run.needsApproval)

/** Whether a session was told, or is told now, that something is up with a run. */
const needsTelling = (run: Run) => waits(run) || hasFailed(run) || isDropped(run)

/**
 * Whether the runs of a commit are settled at a moment.
 *
 * They are once every run has been over for a while, because a failed run is often retried. A run that
 * nobody confirms waits for good, so after a week they are settled whatever their state.
 */
export const settles = (runs: ReadonlyArray<Run>, at: number): boolean => {
  if (runs.length === 0) return false

  if (at - Math.max(...runs.map((run) => run.createdAt)) >= giveUpAfter) return true

  return runs.every(isOver) && at - Math.max(...runs.map((run) => run.updatedAt)) >= quietFor
}

const any = [CommitRunsState.Unseen, CommitRunsState.Running, CommitRunsState.Settled] as const
const isUnseen = CommitRunsState.$is("Unseen")
const isSettled = CommitRunsState.$is("Settled")
const toldOf = (state: CommitRunsState): ReadonlyArray<string> => (isUnseen(state) ? [] : state.told)

/** How the state of a commit's runs follows from what happens to them. */
export const commitRunsMachine = Machine.make({
  state: CommitRunsState,
  event: CommitRunsEvent,
  initial: CommitRunsState.Unseen({ subscribers: [] }),
})
  .on(any, CommitRunsEvent.Observed, ({ state, event }) => {
    const { title, runs } = event.facts
    const finished = new Set(runs.filter((run) => run.state === "FINISHED").map((run) => run.stack))
    const telling = runs.filter(needsTelling).map((run) => run.stack)
    const told = [...new Set([...toldOf(state), ...telling])].filter((stack) => !finished.has(stack))
    const held = { title, runs, told, subscribers: state.subscribers }

    return settles(runs, event.at) ? CommitRunsState.Settled(held) : CommitRunsState.Running(held)
  })
  .on(any, CommitRunsEvent.Attached, ({ state, event }) =>
    CommitRunsState.with(state, { subscribers: attach(state.subscribers, event.subscriber) }),
  )
  .on(any, CommitRunsEvent.Detached, ({ state, event }) =>
    CommitRunsState.with(state, { subscribers: detach(state.subscribers, event.task) }),
  )

/** The runs of a commit as a cell: one per commit. */
export const CommitRunsEntity = toEntity(commitRunsMachine, { type: "CommitRuns" })

const Delta = Run.fields.delta

/** Something that happened to the runs of a commit, in terms a task can act on. */
export const Change = Schema.TaggedUnion({
  /**
   * A stack's run waits for a person. `approval` says that a policy asks for an approval, and otherwise the
   * plan waits to be confirmed. It is told once for a run.
   */
  RunWaits: { stack: Schema.String, url: Schema.String, approval: Schema.Boolean, delta: Delta },
  RunFailed: { stack: Schema.String, url: Schema.String },
  /** A stack's run ended without applying its plan: it was discarded, canceled or stopped. `state` says which. */
  RunDropped: { stack: Schema.String, url: Schema.String, state: Schema.String },
  /** A stack's run finished, after a session was told that a run of the stack waited or failed. */
  RunFinished: { stack: Schema.String },
  /** Every run is over. */
  Settled: {},
})

/** One thing that happened to the runs of a commit. */
export type Change = typeof Change.Type

/** The runs a state holds. None before the first observation. */
export const runsOf = (state: CommitRunsState): ReadonlyArray<Run> => (isUnseen(state) ? [] : state.runs)

/**
 * Whether an observation says nothing the cell does not hold already, so that it need not be stored again.
 *
 * The same runs are worth storing once more when they settle, which the passing of time alone brings about.
 */
export const repeats = (state: CommitRunsState, facts: CommitRunsFacts, at: number): boolean => {
  if (isUnseen(state)) return false

  if (isSettled(state)) return true

  return state.title === facts.title && Equal.equals(state.runs, facts.runs) && !settles(facts.runs, at)
}

/** How the runs ended, or null while one may still change. */
export const outcomeOf = (state: CommitRunsState): Outcome | null => (isSettled(state) ? "completed" : null)

/**
 * What changed between two observations of a commit's runs.
 *
 * A stack has one run at a time, and which run that is can change: a skipped run gives way to the next one,
 * and a failed run to its retry. So the two observations are compared stack by stack. The first observation
 * reports a run that waits or failed already: the hub follows a merged pull request's runs itself, so no
 * session reads their state when they are attached.
 */
export const changes = (before: CommitRunsState, after: CommitRunsState): ReadonlyArray<Change> => {
  if (isUnseen(after)) return []
  const found: Array<Change> = []
  const known = new Map(runsOf(before).map((run) => [run.stack, run]))

  for (const run of after.runs) {
    const earlier = known.get(run.stack)
    const same = earlier?.id === run.id ? earlier : undefined
    const { stack, url } = run

    if (waits(run) && !(same !== undefined && waits(same))) {
      found.push(Change.cases.RunWaits.make({ stack, url, approval: run.state !== "UNCONFIRMED", delta: run.delta }))
    }

    if (hasFailed(run) && !(same !== undefined && hasFailed(same))) found.push(Change.cases.RunFailed.make({ stack, url }))

    if (isDropped(run) && !(same !== undefined && isDropped(same))) {
      found.push(Change.cases.RunDropped.make({ stack, url, state: run.state }))
    }

    if (run.state === "FINISHED" && toldOf(before).includes(stack)) found.push(Change.cases.RunFinished.make({ stack }))
  }

  if (isSettled(after) && !isSettled(before)) found.push(Change.cases.Settled.make({}))

  return found
}

const isEnd = Change.isAnyOf(["Settled"])

/**
 * Whether a change should wake a session of a task with this relation to the runs.
 *
 * An owner hears a run wait for a person, fail, or end without applying, and hears it finish after that.
 * That every run is over wakes nobody: most runs apply on their own, and a session whose work is done has
 * nothing to do about it.
 */
export const wakes = (relation: Relation, change: Change): boolean => relation === "owns" && !isEnd(change)

const plan = (delta: typeof Delta.Type) =>
  delta === null ? "" : ` Its plan adds ${delta.add}, changes ${delta.change} and deletes ${delta.delete}.`

/** One line a session can read, for one change. */
export const describe = (change: Change): string =>
  Change.match(change, {
    RunWaits: ({ stack, url, approval, delta }) =>
      `The run on ${stack} waits for ${approval ? "an approval" : "someone to confirm it"}.${plan(delta)} ${url}`,
    RunFailed: ({ stack, url }) => `The run on ${stack} failed: ${url}`,
    RunDropped: ({ stack, url, state }) => `The run on ${stack} was ${state.toLowerCase()}, so its plan is not applied: ${url}`,
    RunFinished: ({ stack }) => `The run on ${stack} has finished.`,
    Settled: () => "Every run is over.",
  })

/** Where the runs stand, in a few words: how many wait, failed, run and finished. */
export const summaryOf = (state: CommitRunsState): string => {
  if (isUnseen(state)) return "unseen"
  const counts = new Map<string, number>()

  for (const run of state.runs) {
    const word = waits(run) ? "waiting" : hasFailed(run) ? "failed" : isOver(run) ? run.state.toLowerCase() : "running"
    counts.set(word, (counts.get(word) ?? 0) + 1)
  }

  // What needs attention comes first, and the other states a run ends in come last.
  const first = ["waiting", "failed", "running", "finished"].filter((word) => counts.has(word))
  const rest = [...counts.keys()].filter((word) => !first.includes(word))

  return [...first, ...rest].map((word) => `${counts.get(word)} ${word}`).join(", ")
}

/** The stacks whose run waits for a person, and the stacks whose run failed. */
export const attentionOf = (state: CommitRunsState) => ({
  waiting: runsOf(state)
    .filter(waits)
    .map((run) => run.stack),
  failed: runsOf(state)
    .filter(hasFailed)
    .map((run) => run.stack),
})
