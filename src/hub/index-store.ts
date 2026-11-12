import { Effect, Schema } from "effect"
import { PullRequestState, failedChecks } from "./pull-request.ts"
import { type TaskState, isUnborn } from "./task.ts"

/** The read model failed. The cells stay correct, and the next write of the same task repairs the row. */
export class IndexError extends Schema.TaggedError<IndexError>()("IndexError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {}

/** What a task row holds beside its own columns, stored as JSON. */
const TaskDetail = Schema.Struct({
  sessions: Schema.Array(Schema.String),
  running: Schema.Array(Schema.String),
  subagents: Schema.Array(Schema.Struct({ session: Schema.String, kind: Schema.String })),
  questions: Schema.Array(Schema.Struct({ id: Schema.String, kind: Schema.String, title: Schema.String })),
  // Rows of tasks that never followed a resource lack the next two keys.
  attachments: Schema.Array(
    Schema.Struct({ resource: Schema.String, relation: Schema.String, status: Schema.String, note: Schema.String }),
  ).pipe(Schema.optional, Schema.withDecodingDefault(Effect.succeed([]))),
  /** Wake-ups that have not reached a session yet. */
  undelivered: Schema.Number.pipe(Schema.optional, Schema.withDecodingDefault(Effect.succeed(0))),
})

const TaskDetailJson = Schema.fromJsonString(TaskDetail)

export interface TaskRow extends Schema.Schema.Type<typeof TaskDetail> {
  readonly id: string
  readonly parent: string | null
  readonly title: string
  /** What the board shows: NeedsMe, Working, Watching or Idle. */
  readonly state: string
}

export interface TaskNode extends TaskRow {
  readonly children: ReadonlyArray<TaskNode>
}

/** What a pull request row holds beside its own columns. Only an open pull request has more than subscribers. */
const PullRequestDetail = Schema.Struct({
  head: Schema.optional(Schema.String),
  ci: Schema.optional(Schema.String),
  failed: Schema.optional(Schema.Array(Schema.String)),
  reviewDecision: Schema.optional(Schema.NullOr(Schema.String)),
  conflicting: Schema.optional(Schema.Boolean),
  queued: Schema.optional(Schema.Boolean),
  openThreads: Schema.optional(Schema.Number),
  subscribers: Schema.Array(Schema.Struct({ task: Schema.String, relation: Schema.String })),
})

type PullRequestDetail = typeof PullRequestDetail.Type

const PullRequestDetailJson = Schema.fromJsonString(PullRequestDetail)

/** A pull request as the board lists it. */
export interface PullRequestRow {
  readonly key: string
  readonly state: string
  readonly title: string
  readonly detail: PullRequestDetail
}

/** The SQL the index runs. In the hub, D1 runs it. */
export interface Database {
  readonly exec: (statements: string) => Promise<void>
  readonly run: (statement: string, values: ReadonlyArray<string | number | null>) => Promise<void>
  /** The rows of a query. `Row` names the selected columns and is not checked. */
  readonly all: <Row>(query: string) => Promise<ReadonlyArray<Row>>
}

export const d1 = (db: D1Database): Database => ({
  exec: async (statements) => {
    await db.exec(statements)
  },
  run: async (statement, values) => {
    await db
      .prepare(statement)
      .bind(...values)
      .run()
  },
  all: async <Row>(query: string) => (await db.prepare(query).all<Row>()).results,
})

const failed = (operation: string) => (cause: unknown) => new IndexError({ operation, cause })

const run = <A>(operation: string, f: () => Promise<A>) => Effect.tryPromise({ try: f, catch: failed(operation) })

export const migrate = (db: Database) =>
  run("migrate", () =>
    db.exec(
      "CREATE TABLE IF NOT EXISTS task (id TEXT PRIMARY KEY, parent TEXT, title TEXT NOT NULL, state TEXT NOT NULL, detail TEXT NOT NULL, updated_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS pull_request (key TEXT PRIMARY KEY, state TEXT NOT NULL, title TEXT NOT NULL, detail TEXT NOT NULL, watched INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
    ),
  )

export const put = (db: Database, id: string, state: TaskState): Effect.Effect<void, IndexError> => {
  if (isUnborn(state)) return Effect.void

  return Schema.encodeEffect(TaskDetailJson)({
    sessions: state.sessions,
    running: state.running,
    subagents: state.subagents.map(({ session, kind }) => ({ session, kind })),
    questions: state.questions.map(({ id, kind, title }) => ({ id, kind, title })),
    attachments: state.attachments.map(({ resource, relation, status, note }) => ({ resource, relation, status, note })),
    undelivered: state.outbox.length,
  }).pipe(
    Effect.mapError(failed("put")),
    Effect.flatMap((detail) =>
      run("put", () =>
        db.run(
          `INSERT INTO task (id, parent, title, state, detail, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
           ON CONFLICT (id) DO UPDATE SET parent = excluded.parent, title = excluded.title, state = excluded.state,
             detail = excluded.detail, updated_at = excluded.updated_at`,
          [id, state.parent, state.title, state._tag, detail, Date.now()],
        ),
      ),
    ),
  )
}

/** Every task as a forest. A task whose parent is missing from the index is a root. */
export const tree = (db: Database): Effect.Effect<ReadonlyArray<TaskNode>, IndexError> =>
  run("tree", () =>
    db.all<{ id: string; parent: string | null; title: string; state: string; detail: string }>(
      "SELECT id, parent, title, state, detail FROM task ORDER BY updated_at DESC",
    ),
  ).pipe(
    Effect.flatMap((results) =>
      Effect.forEach(results, ({ detail, ...row }) =>
        Effect.map(Schema.decodeEffect(TaskDetailJson)(detail), (decoded): TaskRow => ({ ...row, ...decoded })),
      ),
    ),
    Effect.mapError(failed("tree")),
    Effect.map((rows) => {
      const ids = new Set(rows.map((row) => row.id))
      const byParent = new Map<string | null, Array<TaskRow>>()

      for (const row of rows) {
        const parent = row.parent !== null && ids.has(row.parent) ? row.parent : null
        const siblings = byParent.get(parent) ?? []
        siblings.push(row)
        byParent.set(parent, siblings)
      }

      const childrenOf = (parent: string | null): Array<TaskNode> =>
        (byParent.get(parent) ?? []).map((row) => ({ ...row, children: childrenOf(row.id) }))

      return childrenOf(null)
    }),
  )

export const putPullRequest = (db: Database, key: string, state: PullRequestState): Effect.Effect<void, IndexError> => {
  const subscribers = state.subscribers.map(({ task, relation }) => ({ task, relation }))

  const row = PullRequestState.$match<{ title: string; canChange: boolean; detail: PullRequestDetail }>(state, {
    Unseen: () => ({ title: "", canChange: true, detail: { subscribers } }),
    Merged: ({ title }) => ({ title, canChange: false, detail: { subscribers } }),
    Closed: ({ title }) => ({ title, canChange: false, detail: { subscribers } }),
    Open: (open) => ({
      title: open.title,
      canChange: true,
      detail: {
        head: open.head,
        ci: open.ci._tag,
        failed: failedChecks(open.ci),
        reviewDecision: open.reviewDecision,
        conflicting: open.conflicting,
        queued: open.queued,
        openThreads: open.threads.filter((thread) => !thread.resolved).length,
        subscribers,
      },
    }),
  })

  // A pull request is worth reading again while someone follows it and it can still change.
  const watched = subscribers.length > 0 && row.canChange ? 1 : 0

  return Schema.encodeEffect(PullRequestDetailJson)(row.detail).pipe(
    Effect.mapError(failed("put pull request")),
    Effect.flatMap((detail) =>
      run("put pull request", () =>
        db.run(
          `INSERT INTO pull_request (key, state, title, detail, watched, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
           ON CONFLICT (key) DO UPDATE SET state = excluded.state, title = excluded.title, detail = excluded.detail,
             watched = excluded.watched, updated_at = excluded.updated_at`,
          [key, state._tag, row.title, detail, watched, Date.now()],
        ),
      ),
    ),
  )
}

export const pullRequests = (db: Database, onlyWatched: boolean): Effect.Effect<ReadonlyArray<PullRequestRow>, IndexError> =>
  run("pull requests", () =>
    db.all<{ key: string; state: string; title: string; detail: string }>(
      onlyWatched
        ? "SELECT key, state, title, detail FROM pull_request WHERE watched = 1 ORDER BY key"
        : "SELECT key, state, title, detail FROM pull_request ORDER BY updated_at DESC",
    ),
  ).pipe(
    Effect.flatMap((results) =>
      Effect.forEach(results, (row) =>
        Effect.map(Schema.decodeEffect(PullRequestDetailJson)(row.detail), (detail): PullRequestRow => ({ ...row, detail })),
      ),
    ),
    Effect.mapError(failed("pull requests")),
  )

/** The tasks that hold wake-ups no session has received. */
export const tasksWithUndelivered = (db: Database) =>
  run("undelivered", () =>
    db.all<{ id: string }>("SELECT id FROM task WHERE json_extract(detail, '$.undelivered') > 0"),
  ).pipe(Effect.map((rows) => rows.map((row) => row.id)))
