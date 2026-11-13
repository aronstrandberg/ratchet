import { Context, Effect, Layer, Schema } from "effect"
import { causeText } from "../failure.ts"
import type { SessionId, TaskId } from "../protocol/ids.ts"
import type { PullRequestKey } from "../protocol/pull-request.ts"
import * as Index from "./index-store.ts"
import { PullRequestEntity, type PullRequestEvent, type PullRequestState } from "./pull-request.ts"
import { SessionEntity, SessionEvent, type SessionState } from "./session.ts"
import { TaskEntity, type TaskEvent, type TaskState } from "./task.ts"

/** A cell did not answer: its runner is away, its mailbox is full, or its store failed. */
export class CellUnavailable extends Schema.TaggedError<CellUnavailable>()("CellUnavailable", {
  /** The kind of cell and its ID, such as `Task/tsk_1`. */
  cell: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `${this.cell} did not answer: ${causeText(this.cause)}`
  }
}

/**
 * The tasks, sessions and pull requests as stored cells, with the read model kept in step.
 *
 * Every change to a task or a pull request goes through here, so its row in the index is written by the
 * same call that changed the cell.
 */
export interface Interface {
  readonly task: (id: TaskId) => Effect.Effect<TaskState, CellUnavailable>
  /** Sends a task an event and writes the state it answers with to the index. */
  readonly sendTask: (
    id: TaskId,
    event: typeof TaskEvent.Type,
  ) => Effect.Effect<TaskState, CellUnavailable | Index.IndexError>
  readonly session: (id: SessionId) => Effect.Effect<SessionState, CellUnavailable>
  /** Makes `task` the task a session works on now. */
  readonly bind: (session: SessionId, task: TaskId) => Effect.Effect<SessionState, CellUnavailable>
  readonly pullRequest: (key: PullRequestKey) => Effect.Effect<PullRequestState, CellUnavailable>
  /** Sends a pull request an event and writes the state it answers with to the index. */
  readonly sendPullRequest: (
    key: PullRequestKey,
    event: typeof PullRequestEvent.Type,
  ) => Effect.Effect<PullRequestState, CellUnavailable | Index.IndexError>
}

/** The hub's cells. */
export class Service extends Context.Service<Service, Interface>()("@ratchet/hub/Cells") {}

const unavailable = (cell: string) => (cause: unknown) => new CellUnavailable({ cell, cause })

/** Builds the cells on the cluster's entity clients and the index. */
export const make = Effect.gen(function* () {
  const index = yield* Index.Service
  const tasks = yield* TaskEntity.client
  const sessions = yield* SessionEntity.client
  const pullRequests = yield* PullRequestEntity.client

  return Service.of({
    task: (id) => tasks(id).GetState().pipe(Effect.mapError(unavailable(`Task/${id}`))),
    sendTask: (id, event) =>
      tasks(id)
        .Send({ event })
        .pipe(
          Effect.mapError(unavailable(`Task/${id}`)),
          Effect.tap((state) => index.putTask(id, state)),
        ),
    session: (id) => sessions(id).GetState().pipe(Effect.mapError(unavailable(`Session/${id}`))),
    bind: (session, task) =>
      sessions(session)
        .Send({ event: SessionEvent.Bound({ task }) })
        .pipe(Effect.mapError(unavailable(`Session/${session}`))),
    pullRequest: (key) => pullRequests(key).GetState().pipe(Effect.mapError(unavailable(`PullRequest/${key}`))),
    sendPullRequest: (key, event) =>
      pullRequests(key)
        .Send({ event })
        .pipe(
          Effect.mapError(unavailable(`PullRequest/${key}`)),
          Effect.tap((state) => index.putPullRequest(key, state)),
        ),
  })
})

/** The cells, still in need of the cluster's entities and the index. */
export const layerWithoutDependencies = Layer.effect(Service, make)
