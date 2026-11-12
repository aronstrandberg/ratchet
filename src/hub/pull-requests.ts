import { Effect, Result, Schema } from "effect"
import { type PullRequestFacts, type PullRequestRef, Relation, WorkStatus, pullRequestKey } from "../protocol/pull-request.ts"
import { taskOf } from "./commands.ts"
import * as Index from "./index-store.ts"
import {
  type Change,
  PullRequestEntity,
  PullRequestEvent,
  PullRequestState,
  changes,
  describe,
  failedChecks,
  wakes,
} from "./pull-request.ts"
import { TaskEntity, TaskEvent, isUnborn } from "./task.ts"

const sendTask = (db: Index.Database, task: string, event: typeof TaskEvent.Type) =>
  Effect.flatMap(TaskEntity.client, (tasks) => tasks(task).Send({ event })).pipe(
    Effect.tap((state) => Index.put(db, task, state)),
  )

/** Attaches a pull request to the session's current task, so the task hears what happens to it. */
export const register = (db: Index.Database, session: string, ref: PullRequestRef, relation: Relation) =>
  Effect.gen(function* () {
    const task = yield* taskOf(session)
    const key = pullRequestKey(ref)

    const pullRequest = yield* (yield* PullRequestEntity.client)(key).Send({
      event: PullRequestEvent.Attached({ subscriber: { task, session, relation } }),
    })

    yield* Index.putPullRequest(db, key, pullRequest)
    yield* sendTask(db, task, TaskEvent.Attached({ resource: key, relation, session }))

    return { task, pullRequest: key }
  })

export class NotRegistered extends Schema.TaggedError<NotRegistered>()("NotRegistered", {
  pullRequest: Schema.String,
}) {}

const attachmentsOf = (task: string) =>
  Effect.flatMap(TaskEntity.client, (tasks) => tasks(task).GetState()).pipe(
    Effect.map((state) => (isUnborn(state) ? [] : state.attachments)),
  )

/** Records what the session says about its work on a pull request its task follows. */
export const setStatus = (db: Index.Database, session: string, ref: PullRequestRef, status: WorkStatus, note: string) =>
  Effect.gen(function* () {
    const task = yield* taskOf(session)
    const key = pullRequestKey(ref)

    if (!(yield* attachmentsOf(task)).some((attachment) => attachment.resource === key)) {
      return yield* new NotRegistered({ pullRequest: key })
    }

    yield* sendTask(db, task, TaskEvent.StatusSet({ resource: key, status, note }))

    return { task, pullRequest: key }
  })

/** Stops the session's current task following a pull request. */
export const unregister = (db: Index.Database, session: string, ref: PullRequestRef) =>
  Effect.gen(function* () {
    const task = yield* taskOf(session)
    const key = pullRequestKey(ref)
    const pullRequest = yield* (yield* PullRequestEntity.client)(key).Send({ event: PullRequestEvent.Detached({ task }) })
    yield* Index.putPullRequest(db, key, pullRequest)
    yield* sendTask(db, task, TaskEvent.Detached({ resource: key }))

    return { task, pullRequest: key }
  })

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
  pullRequest: Schema.String,
  relation: Relation,
  status: WorkStatus,
  note: Schema.String,
  github: GitHubView,
})

/** The pull requests a task follows. */
export const Following = Schema.Struct({ task: Schema.String, pullRequests: Schema.Array(Followed) })

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

/** The pull requests the session's current task follows, with what GitHub last said about each. */
export const list = (session: string) =>
  Effect.gen(function* () {
    const task = yield* taskOf(session)
    const pullRequests = yield* PullRequestEntity.client
    const rows: Array<typeof Followed.Type> = []

    for (const attachment of yield* attachmentsOf(task)) {
      rows.push({
        pullRequest: attachment.resource,
        relation: attachment.relation,
        status: attachment.status,
        note: attachment.note,
        github: githubView(yield* pullRequests(attachment.resource).GetState()),
      })
    }

    return { task, pullRequests: rows }
  })

const wakeText = (facts: PullRequestFacts, relevant: ReadonlyArray<Change>) =>
  [
    `Ratchet: pull request ${facts.ref.owner}/${facts.ref.repo}#${facts.ref.number} changed.`,
    ...relevant.map((change) => `- ${describe(change)}`),
    "This is an automatic notification, not a message from Aron. Read the pull request before you act on it.",
  ].join("\n")

/** A stable ID for one batch of changes on one head, so the same observation never wakes a session twice. */
const wakeId = (key: string, facts: PullRequestFacts, relevant: ReadonlyArray<Change>) =>
  `${key}@${facts.head.slice(0, 12)}:${relevant.map((change) => change._tag).join("+")}`

/**
 * Applies a fresh observation of a pull request and queues a wake-up for each session it concerns.
 *
 * `mayWake` says which sessions may be woken. It returns the tasks that now hold undelivered wake-ups.
 */
export const observe = (db: Index.Database, facts: PullRequestFacts, mayWake: (session: string) => boolean) =>
  Effect.gen(function* () {
    const key = pullRequestKey(facts.ref)
    const pullRequest = (yield* PullRequestEntity.client)(key)
    const before = yield* pullRequest.GetState()
    const after = yield* pullRequest.Send({ event: PullRequestEvent.Observed({ facts }) })
    yield* Index.putPullRequest(db, key, after)
    const found = changes(before, after)
    const queued: Array<string> = []

    for (const subscriber of after.subscribers) {
      const relevant = found.filter((change) => wakes(subscriber.relation, change))

      if (relevant.length === 0 || !mayWake(subscriber.session)) continue
      yield* sendTask(
        db,
        subscriber.task,
        TaskEvent.WakeQueued({
          id: wakeId(key, facts, relevant),
          session: subscriber.session,
          text: wakeText(facts, relevant),
        }),
      )
      queued.push(subscriber.task)
    }

    return { changes: found.map((change) => change._tag), queued }
  })

/**
 * Delivers a task's queued wake-ups through `wake`, and takes each off the queue once it is delivered.
 *
 * A wake-up that fails stays queued for the next call.
 */
export const deliver = <E>(db: Index.Database, task: string, wake: (session: string, text: string) => Effect.Effect<void, E>) =>
  Effect.gen(function* () {
    const state = yield* (yield* TaskEntity.client)(task).GetState()

    if (isUnborn(state)) return 0
    let delivered = 0

    for (const queued of state.outbox) {
      const sent = yield* Effect.result(wake(queued.session, queued.text))

      if (Result.isFailure(sent)) continue
      yield* sendTask(db, task, TaskEvent.WakeDelivered({ id: queued.id }))
      delivered++
    }

    return delivered
  })
