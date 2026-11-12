import { Effect } from "effect"
import {
  type PullRequestFacts,
  type PullRequestRef,
  type Relation,
  type WorkStatus,
  pullRequestKey,
} from "../protocol/pull-request.ts"
import { Schema } from "effect"
import { NoTask } from "./commands.ts"
import * as Index from "./index-store.ts"
import { type Change, PullRequestEntity, PullRequestEvent, changes, describe, wakes } from "./pull-request.ts"
import { SessionEntity } from "./session.ts"
import { TaskEntity, TaskEvent } from "./task.ts"

const taskOf = (session: string) =>
  Effect.flatMap(SessionEntity.client, (sessions) => sessions(session).GetState()).pipe(
    Effect.flatMap((state) => (state._tag === "Bound" ? Effect.succeed(state.task) : Effect.fail(new NoTask({ session })))),
  )

const sendTask = (db: D1Database, task: string, event: typeof TaskEvent.Type) =>
  Effect.flatMap(TaskEntity.client, (tasks) => tasks(task).Send({ event })).pipe(
    Effect.tap((state) => Index.put(db, task, state)),
  )

/** Attaches a pull request to the session's current task, so the task hears what happens to it. */
export const register = (db: D1Database, session: string, ref: PullRequestRef, relation: Relation) =>
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
    Effect.map((state) => (state._tag === "Unborn" ? [] : state.attachments)),
  )

/** Records what the session says about its work on a pull request its task follows. */
export const setStatus = (db: D1Database, session: string, ref: PullRequestRef, status: WorkStatus, note: string) =>
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
export const unregister = (db: D1Database, session: string, ref: PullRequestRef) =>
  Effect.gen(function* () {
    const task = yield* taskOf(session)
    const key = pullRequestKey(ref)
    const pullRequest = yield* (yield* PullRequestEntity.client)(key).Send({ event: PullRequestEvent.Detached({ task }) })
    yield* Index.putPullRequest(db, key, pullRequest)
    yield* sendTask(db, task, TaskEvent.Detached({ resource: key }))

    return { task, pullRequest: key }
  })

/** The pull requests the session's current task follows, with what GitHub last said about each. */
export const list = (session: string) =>
  Effect.gen(function* () {
    const task = yield* taskOf(session)
    const pullRequests = yield* PullRequestEntity.client
    const rows = []

    for (const attachment of yield* attachmentsOf(task)) {
      const state = yield* pullRequests(attachment.resource).GetState()
      rows.push({
        pullRequest: attachment.resource,
        relation: attachment.relation,
        status: attachment.status,
        note: attachment.note,
        github:
          state._tag === "Open"
            ? {
                state: "open" as const,
                ci: state.ci._tag,
                failed: state.ci._tag === "Running" ? [] : state.ci.failed,
                reviewDecision: state.reviewDecision,
                conflicting: state.conflicting,
                queued: state.queued,
                openThreads: state.threads.filter((thread) => !thread.resolved).length,
              }
            : { state: state._tag === "Unseen" ? ("unseen" as const) : state._tag === "Merged" ? ("merged" as const) : ("closed" as const) },
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
export const observe = (db: D1Database, facts: PullRequestFacts, mayWake: (session: string) => boolean) =>
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
export const deliver = <E>(db: D1Database, task: string, wake: (session: string, text: string) => Effect.Effect<void, E>) =>
  Effect.gen(function* () {
    const state = yield* (yield* TaskEntity.client)(task).GetState()

    if (state._tag === "Unborn") return 0
    let delivered = 0

    for (const queued of state.outbox) {
      const sent = yield* Effect.result(wake(queued.session, queued.text))

      if (sent._tag === "Failure") continue
      yield* sendTask(db, task, TaskEvent.WakeDelivered({ id: queued.id }))
      delivered++
    }

    return delivered
  })
