import { Context, Effect, Layer, Schema } from "effect"
import { causeText } from "../failure.ts"
import type { SessionId, TaskId } from "../protocol/ids.ts"
import type { ResourceKey } from "../protocol/resource.ts"
import { IncidentEntity, type IncidentEvent, type IncidentState } from "./incident.ts"
import * as Index from "./index-store.ts"
import { LinearIssueEntity, type LinearIssueEvent, type LinearIssueState } from "./linear-issue.ts"
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
 * The tasks, sessions and resources as stored cells, with the read model kept in step.
 *
 * Every change to a task or a resource goes through here, so its row in the index is written by the same
 * call that changed the cell.
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
  readonly pullRequest: (key: ResourceKey) => Effect.Effect<PullRequestState, CellUnavailable>
  /** Sends a pull request an event and writes the state it answers with to the index. */
  readonly sendPullRequest: (
    key: ResourceKey,
    event: typeof PullRequestEvent.Type,
  ) => Effect.Effect<PullRequestState, CellUnavailable | Index.IndexError>
  readonly linearIssue: (key: ResourceKey) => Effect.Effect<LinearIssueState, CellUnavailable>
  /** Sends a Linear issue an event and writes the state it answers with to the index. */
  readonly sendLinearIssue: (
    key: ResourceKey,
    event: typeof LinearIssueEvent.Type,
  ) => Effect.Effect<LinearIssueState, CellUnavailable | Index.IndexError>
  readonly incident: (key: ResourceKey) => Effect.Effect<IncidentState, CellUnavailable>
  /** Sends an incident an event and writes the state it answers with to the index. */
  readonly sendIncident: (
    key: ResourceKey,
    event: typeof IncidentEvent.Type,
  ) => Effect.Effect<IncidentState, CellUnavailable | Index.IndexError>
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
  const linearIssues = yield* LinearIssueEntity.client
  const incidents = yield* IncidentEntity.client

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
    linearIssue: (key) => linearIssues(key).GetState().pipe(Effect.mapError(unavailable(`LinearIssue/${key}`))),
    sendLinearIssue: (key, event) =>
      linearIssues(key)
        .Send({ event })
        .pipe(
          Effect.mapError(unavailable(`LinearIssue/${key}`)),
          Effect.tap((state) => index.putLinearIssue(key, state)),
        ),
    incident: (key) => incidents(key).GetState().pipe(Effect.mapError(unavailable(`Incident/${key}`))),
    sendIncident: (key, event) =>
      incidents(key)
        .Send({ event })
        .pipe(
          Effect.mapError(unavailable(`Incident/${key}`)),
          Effect.tap((state) => index.putIncident(key, state)),
        ),
  })
})

/** The cells, still in need of the cluster's entities and the index. */
export const layerWithoutDependencies = Layer.effect(Service, make)
