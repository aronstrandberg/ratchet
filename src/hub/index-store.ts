import { Effect, Schema } from "effect"
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
}

export interface TaskNode extends TaskRow {
  readonly children: ReadonlyArray<TaskNode>
}

const run = <A>(operation: string, f: () => Promise<A>) =>
  Effect.tryPromise({ try: f, catch: (cause) => new IndexError({ operation, cause }) })

export const migrate = (db: D1Database) =>
  run("migrate", () =>
    db.exec(
      "CREATE TABLE IF NOT EXISTS task (id TEXT PRIMARY KEY, parent TEXT, title TEXT NOT NULL, state TEXT NOT NULL, detail TEXT NOT NULL, updated_at INTEGER NOT NULL)",
    ),
  )

export const put = (db: D1Database, id: string, state: TaskState) => {
  if (state._tag === "Unborn") return Effect.void
  const detail = JSON.stringify({
    sessions: state.sessions,
    running: state.running,
    subagents: state.subagents.map(({ session, kind }) => ({ session, kind })),
    questions: state.questions.map(({ id, kind, title }) => ({ id, kind, title })),
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
        ...(JSON.parse(detail) as Pick<TaskRow, "sessions" | "running" | "subagents" | "questions">),
      }))
      const ids = new Set(rows.map((row) => row.id))
      const childrenOf = (parent: string | null): Array<TaskNode> =>
        rows
          .filter((row) => (parent === null ? row.parent === null || !ids.has(row.parent) : row.parent === parent))
          .map((row) => ({ ...row, children: childrenOf(row.id) }))
      return childrenOf(null)
    }),
  )
