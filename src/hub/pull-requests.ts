import { Clock, Context, Effect, Layer, Option, Result, Schema } from "effect"
import { type SessionId, TaskId } from "../protocol/ids.ts"
import {
  type PullRequestFacts,
  PullRequestKey,
  type PullRequestRef,
  Relation,
  WorkStatus,
  keyOf,
  refOf,
} from "../protocol/pull-request.ts"
import * as Cells from "./cells.ts"
import * as Index from "./index-store.ts"
import * as PullRequestSource from "./pull-request-source.ts"
import {
  type Change,
  PullRequestEvent,
  PullRequestState,
  changes,
  describe,
  failedChecks,
  outcomeOf,
  wakes,
} from "./pull-request.ts"
import * as SessionControl from "./session-control.ts"
import { boundTask } from "./session.ts"
import { TaskEvent, isUnborn } from "./task.ts"
import * as Tasks from "./tasks.ts"
import * as WakePolicy from "./wake-policy.ts"

/** No task of the session follows this pull request. */
export class NotRegistered extends Schema.TaggedError<NotRegistered>()("NotRegistered", {
  pullRequest: PullRequestKey,
}) {}

/** What GitHub last said about a pull request. Only an open one has more than its state. */
const GitHubView = Schema.Struct({
  state: Schema.Literals(["unseen", "open", "merged", "closed"]),
  ci: Schema.optional(Schema.Literals(["Running", "Failing", "Finished"])),
  failed: Schema.optional(Schema.Array(Schema.String)),
  reviewDecision: Schema.optional(Schema.NullOr(Schema.String)),
  conflicting: Schema.optional(Schema.Boolean),
  queued: Schema.optional(Schema.Boolean),
  openThreads: Schema.optional(Schema.Int),
})

type GitHubView = typeof GitHubView.Type

const Followed = Schema.Struct({
  pullRequest: PullRequestKey,
  /** The task that follows it: the session's current task or one it worked on before. */
  task: TaskId,
  relation: Relation,
  status: WorkStatus,
  note: Schema.String,
  github: GitHubView,
})

/** The pull requests the tasks of a session follow. `task` is the session's current task. */
export const Following = Schema.Struct({ task: TaskId, pullRequests: Schema.Array(Followed) })

export type Following = typeof Following.Type

/** A pull request and the task of the session that follows it. */
export const Registration = Schema.Struct({ task: TaskId, pullRequest: PullRequestKey })

export type Registration = typeof Registration.Type

/** What applying an observation did: the changes it found and how many wake-ups reached their session. */
export interface Observed {
  readonly changes: ReadonlyArray<Change["_tag"]>
  readonly woke: number
}

type Failure = Cells.CellUnavailable | Index.IndexError

/** The pull requests tasks follow: who follows what, what changed, and who is told. */
export interface Interface {
  /**
   * Attaches a pull request to a task of the session and reads it from GitHub for the first time.
   *
   * The task is the session's current one, unless one of its earlier tasks follows the pull request already.
   * `wakes` says whether Ratchet will message the session when the pull request needs action.
   */
  readonly register: (
    session: SessionId,
    ref: PullRequestRef,
    relation: Relation,
  ) => Effect.Effect<
    Registration & { readonly wakes: boolean },
    Tasks.NoTask | PullRequestSource.PullRequestNotFound | PullRequestSource.PullRequestUnreadable | Failure
  >
  /** Records what the session says about its work on a pull request one of its tasks follows. */
  readonly setStatus: (
    session: SessionId,
    ref: PullRequestRef,
    status: WorkStatus,
    note: string,
  ) => Effect.Effect<Registration, Tasks.NoTask | NotRegistered | Failure>
  /** Stops a task of the session following a pull request. */
  readonly unregister: (
    session: SessionId,
    ref: PullRequestRef,
  ) => Effect.Effect<Registration, Tasks.NoTask | NotRegistered | Failure>
  /** The pull requests the session's tasks follow, with what GitHub last said about each. */
  readonly list: (session: SessionId) => Effect.Effect<Following, Tasks.NoTask | Cells.CellUnavailable>
  /**
   * Applies a fresh observation of a pull request, queues a wake-up for each session it concerns, and
   * delivers those wake-ups.
   */
  readonly observe: (facts: PullRequestFacts) => Effect.Effect<Observed, Failure>
  /** Tries again to deliver every wake-up that has not reached its session, and returns how many did. */
  readonly deliverPending: Effect.Effect<number, Failure>
  /** The pull requests worth reading again: someone follows them and they are not merged or closed. */
  readonly watched: Effect.Effect<ReadonlyArray<PullRequestRef>, Index.IndexError>
}

/** The hub's pull requests. */
export class Service extends Context.Service<Service, Interface>()("@ratchet/hub/PullRequests") {}

const githubView = (state: PullRequestState): GitHubView =>
  PullRequestState.$match<GitHubView>(state, {
    Unseen: () => ({ state: "unseen" }),
    Merged: () => ({ state: "merged" }),
    Closed: () => ({ state: "closed" }),
    Open: (open) => ({
      state: "open",
      ci: open.ci._tag,
      failed: failedChecks(open.ci),
      reviewDecision: open.reviewDecision,
      conflicting: open.conflicting,
      queued: open.queued,
      openThreads: open.threads.filter((thread) => !thread.resolved).length,
    }),
  })

/** The task a wake-up is about, as the woken session should read it. */
interface Subject {
  readonly title: string
  /** Whether it is the task the session works on now. */
  readonly current: boolean
}

const wakeText = (facts: PullRequestFacts, relevant: ReadonlyArray<Change>, subject: Subject) =>
  [
    `Ratchet: pull request ${facts.ref.owner}/${facts.ref.repo}#${facts.ref.number} changed.`,
    ...relevant.map((change) => `- ${describe(change)}`),
    subject.current
      ? `It belongs to your task "${subject.title}".`
      : `It belongs to "${subject.title}", a task you worked on before the one you work on now.`,
    "This is an automatic notification, not a message from Aron. Read the pull request before you act on it.",
  ].join("\n")

/** A stable ID for one batch of changes on one head, so the same observation never wakes a session twice. */
const wakeId = (key: PullRequestKey, facts: PullRequestFacts, relevant: ReadonlyArray<Change>) =>
  `${key}@${facts.head.slice(0, 12)}:${relevant.map((change) => change._tag).join("+")}`

/** Builds the pull requests on the cells, the tasks, the index, GitHub reads and control over sessions. */
export const make = Effect.gen(function* () {
  const cells = yield* Cells.Service
  const tasks = yield* Tasks.Service
  const index = yield* Index.Service
  const source = yield* PullRequestSource.Service
  const control = yield* SessionControl.Service
  const policy = yield* WakePolicy.Service

  const attachmentsOf = (task: TaskId) =>
    Effect.map(cells.task(task), (state) => (isUnborn(state) ? [] : state.attachments))

  /**
   * The task of the session that follows a pull request.
   *
   * A pull request stays with the task it was attached to when its session starts another task, so this
   * looks through every task the session has worked on, the current one first.
   */
  const followerOf = Effect.fn("PullRequests.followerOf")(function* (session: SessionId, key: PullRequestKey) {
    for (const task of yield* tasks.tasksOf(session)) {
      if ((yield* attachmentsOf(task)).some((attachment) => attachment.resource === key)) return Option.some(task)
    }

    return Option.none<TaskId>()
  })

  const followerOrFail = (session: SessionId, key: PullRequestKey) =>
    Effect.flatMap(
      followerOf(session, key),
      Option.match({
        onNone: () => Effect.fail(new NotRegistered({ pullRequest: key })),
        onSome: (task) => Effect.succeed(task),
      }),
    )

  const detach = Effect.fn("PullRequests.detach")(function* (task: TaskId, key: PullRequestKey) {
    yield* cells.sendPullRequest(key, PullRequestEvent.Detached({ task }))
    yield* cells.sendTask(task, TaskEvent.Detached({ resource: key }))
  })

  const deliver = Effect.fn("PullRequests.deliver")(function* (task: TaskId) {
    const state = yield* cells.task(task)

    if (isUnborn(state)) return 0
    let delivered = 0

    for (const queued of state.outbox) {
      // A wake-up that fails stays queued. It is sent again with the same ID, which OpenCode admits once.
      const sent = yield* Effect.result(control.wake(queued))

      if (Result.isFailure(sent)) continue
      yield* cells.sendTask(task, TaskEvent.WakeDelivered({ id: queued.id }))
      delivered++
    }

    return delivered
  })

  const observe = Effect.fn("PullRequests.observe")(function* (facts: PullRequestFacts) {
    const key = keyOf(facts.ref)
    const before = yield* cells.pullRequest(key)
    const after = yield* cells.sendPullRequest(key, PullRequestEvent.Observed({ facts }))
    const found = changes(before, after)
    const outcome = outcomeOf(after)
    const now = yield* Clock.currentTimeMillis

    // Every follower learns that it ended, whether or not its session is woken.
    if (outcome !== null && found.length > 0) {
      for (const subscriber of after.subscribers) {
        yield* cells.sendTask(subscriber.task, TaskEvent.ResourceEnded({ resource: key, outcome }))
      }
    }

    let woke = 0

    for (const subscriber of after.subscribers) {
      const relevant = found.filter((change) => wakes(subscriber.relation, change))

      if (relevant.length === 0 || !WakePolicy.allows(policy, subscriber.session)) continue
      const task = yield* cells.task(subscriber.task)

      if (isUnborn(task)) continue
      const current = boundTask(yield* cells.session(subscriber.session)) === subscriber.task
      yield* cells.sendTask(
        subscriber.task,
        TaskEvent.WakeQueued({
          id: wakeId(key, facts, relevant),
          session: subscriber.session,
          text: wakeText(facts, relevant, { title: task.title, current }),
          at: now,
        }),
      )
      woke += yield* deliver(subscriber.task)
    }

    return { changes: found.map((change) => change._tag), woke }
  })

  const register = Effect.fn("PullRequests.register")(function* (
    session: SessionId,
    ref: PullRequestRef,
    relation: Relation,
  ) {
    const key = keyOf(ref)
    const follower = yield* followerOf(session, key)
    const task = Option.isSome(follower) ? follower.value : yield* tasks.taskOf(session)

    yield* cells.sendPullRequest(key, PullRequestEvent.Attached({ subscriber: { task, session, relation } }))
    yield* cells.sendTask(task, TaskEvent.Attached({ resource: key, relation, session }))

    // The first read gives the task something to show. A pull request GitHub does not have is not followed.
    const facts = yield* source.read(ref).pipe(Effect.tapErrorTag("PullRequestNotFound", () => detach(task, key)))
    yield* observe(facts)

    return { task, pullRequest: key, wakes: relation !== "context" && WakePolicy.allows(policy, session) }
  })

  const setStatus = Effect.fn("PullRequests.setStatus")(function* (
    session: SessionId,
    ref: PullRequestRef,
    status: WorkStatus,
    note: string,
  ) {
    const key = keyOf(ref)
    const task = yield* followerOrFail(session, key)
    yield* cells.sendTask(task, TaskEvent.StatusSet({ resource: key, status, note }))

    return { task, pullRequest: key }
  })

  const unregister = Effect.fn("PullRequests.unregister")(function* (session: SessionId, ref: PullRequestRef) {
    const key = keyOf(ref)
    const task = yield* followerOrFail(session, key)
    yield* detach(task, key)

    return { task, pullRequest: key }
  })

  const list = Effect.fn("PullRequests.list")(function* (session: SessionId) {
    const rows: Array<typeof Followed.Type> = []

    for (const follower of yield* tasks.tasksOf(session)) {
      for (const attachment of yield* attachmentsOf(follower)) {
        rows.push({
          pullRequest: attachment.resource,
          task: follower,
          relation: attachment.relation,
          status: attachment.status,
          note: attachment.note,
          github: githubView(yield* cells.pullRequest(attachment.resource)),
        })
      }
    }

    return { task: yield* tasks.taskOf(session), pullRequests: rows }
  })

  const deliverPending = Effect.gen(function* () {
    let woke = 0

    for (const task of yield* index.tasksWithUndelivered) woke += yield* deliver(task)

    return woke
  }).pipe(Effect.withSpan("PullRequests.deliverPending"))

  const watched = Effect.map(index.pullRequests("watched"), (rows) =>
    rows.flatMap((row) => Option.toArray(refOf(row.key))),
  )

  return Service.of({ register, setStatus, unregister, list, observe, deliverPending, watched })
})

/** The pull requests, still in need of everything they are built on. */
export const layerWithoutDependencies = Layer.effect(Service, make)
