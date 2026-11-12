import { Effect, Schema } from "effect"
import type { PullRequestState } from "./pull-request.ts"
import type { TaskState } from "./task.ts"

/** The read model failed. The cells stay correct, and the next write of the same task repairs the row. */
export class IndexError extends Schema.TaggedError<IndexError>()("IndexError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {}

export interface TaskRow {
  readonly id: string
  readonly parent: string | null
  readonly title: string
  /** What the board shows: NeedsMe, Working, Watching or Idle. */
  readonly state: string
  readonly sessions: ReadonlyArray<string>
  readonly running: ReadonlyArray<string>
  readonly subagents: ReadonlyArray<{ readonly session: string; readonly kind: string }>
  readonly questions: ReadonlyArray<{ readonly id: string; readonly kind: string; readonly title: string }>
  readonly attachments: ReadonlyArray<{
    readonly resource: string
    readonly relation: string
    readonly status: string
    readonly note: string
  }>
  /** Wake-ups that have not reached a session yet. */
  readonly undelivered: number
}

/** A pull request as the board lists it. */
export interface PullRequestRow {
  readonly key: string
  readonly state: string
  readonly title: string
  readonly detail: {
    readonly head?: string
    readonly ci?: string
    readonly failed?: ReadonlyArray<string>
    readonly reviewDecision?: string | null
    readonly conflicting?: boolean
    readonly queued?: boolean
    readonly openThreads?: number
    readonly subscribers: ReadonlyArray<{ readonly task: string; readonly relation: string }>
  }
}

export interface TaskNode extends TaskRow {
  readonly children: ReadonlyArray<TaskNode>
}

const run = <A>(operation: string, f: () => Promise<A>) =>
  Effect.tryPromise({ try: f, catch: (cause) => new IndexError({ operation, cause }) })

export const migrate = (db: D1Database) =>
  run("migrate", () =>
    db.exec(
      "CREATE TABLE IF NOT EXISTS task (id TEXT PRIMARY KEY, parent TEXT, title TEXT NOT NULL, state TEXT NOT NULL, detail TEXT NOT NULL, updated_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS pull_request (key TEXT PRIMARY KEY, state TEXT NOT NULL, title TEXT NOT NULL, detail TEXT NOT NULL, watched INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
    ),
  )

export const put = (db: D1Database, id: string, state: TaskState) => {
  if (state._tag === "Unborn") return Effect.void
  const detail = JSON.stringify({
    sessions: state.sessions,
    running: state.running,
    subagents: state.subagents.map(({ session, kind }) => ({ session, kind })),
    questions: state.questions.map(({ id, kind, title }) => ({ id, kind, title })),
    attachments: state.attachments.map(({ resource, relation, status, note }) => ({ resource, relation, status, note })),
    undelivered: state.outbox.length,
  })
  return run("put", () =>
    db
      .prepare(
        `INSERT INTO task (id, parent, title, state, detail, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (id) DO UPDATE SET parent = excluded.parent, title = excluded.title, state = excluded.state,
           detail = excluded.detail, updated_at = excluded.updated_at`,
      )
      .bind(id, state.parent, state.title, state._tag, detail, Date.now())
      .run(),
  ).pipe(Effect.asVoid)
}

/** Every task as a forest. A task whose parent is missing from the index is a root. */
export const tree = (db: D1Database) =>
  run("tree", () =>
    db
      .prepare("SELECT id, parent, title, state, detail FROM task ORDER BY updated_at DESC")
      .all<{ id: string; parent: string | null; title: string; state: string; detail: string }>(),
  ).pipe(
    Effect.map(({ results }) => {
      const rows: Array<TaskRow> = results.map(({ detail, ...row }) => ({
        ...row,
        ...(JSON.parse(detail) as Omit<TaskRow, "id" | "parent" | "title" | "state">),
      }))
      const ids = new Set(rows.map((row) => row.id))
      const childrenOf = (parent: string | null): Array<TaskNode> =>
        rows
          .filter((row) => (parent === null ? row.parent === null || !ids.has(row.parent) : row.parent === parent))
          .map((row) => ({ ...row, children: childrenOf(row.id) }))
      return childrenOf(null)
    }),
  )

export const putPullRequest = (db: D1Database, key: string, state: PullRequestState) => {
  const subscribers = state.subscribers.map(({ task, relation }) => ({ task, relation }))
  const detail: PullRequestRow["detail"] =
    state._tag === "Open"
      ? {
          head: state.head,
          ci: state.ci._tag,
          failed: state.ci._tag === "Running" ? [] : state.ci.failed,
          reviewDecision: state.reviewDecision,
          conflicting: state.conflicting,
          queued: state.queued,
          openThreads: state.threads.filter((thread) => !thread.resolved).length,
          subscribers,
        }
      : { subscribers }
  // A pull request is worth reading again while someone follows it and it can still change.
  const watched = subscribers.length > 0 && (state._tag === "Open" || state._tag === "Unseen") ? 1 : 0
  return run("put pull request", () =>
    db
      .prepare(
        `INSERT INTO pull_request (key, state, title, detail, watched, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (key) DO UPDATE SET state = excluded.state, title = excluded.title, detail = excluded.detail,
           watched = excluded.watched, updated_at = excluded.updated_at`,
      )
      .bind(key, state._tag, state._tag === "Unseen" ? "" : state.title, JSON.stringify(detail), watched, Date.now())
      .run(),
  ).pipe(Effect.asVoid)
}

export const pullRequests = (db: D1Database, onlyWatched: boolean) =>
  run("pull requests", () =>
    db
      .prepare(
        onlyWatched
          ? "SELECT key, state, title, detail FROM pull_request WHERE watched = 1 ORDER BY key"
          : "SELECT key, state, title, detail FROM pull_request ORDER BY updated_at DESC",
      )
      .all<{ key: string; state: string; title: string; detail: string }>(),
  ).pipe(
    Effect.map(({ results }) =>
      results.map((row): PullRequestRow => ({ ...row, detail: JSON.parse(row.detail) as PullRequestRow["detail"] })),
    ),
  )

/** The tasks that hold wake-ups no session has received. */
export const tasksWithUndelivered = (db: D1Database) =>
  run("undelivered", () =>
    db.prepare("SELECT id FROM task WHERE json_extract(detail, '$.undelivered') > 0").all<{ id: string }>(),
  ).pipe(Effect.map(({ results }) => results.map((row) => row.id)))
