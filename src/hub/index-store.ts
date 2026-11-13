import { Clock, Context, Effect, Layer, Ref, Schema } from "effect"
import { TaskId } from "../protocol/ids.ts"
import { PullRequestKey } from "../protocol/pull-request.ts"
import { PullRequestState, failedChecks } from "./pull-request.ts"
import { type TaskState, isUnborn } from "./task.ts"

/** The read model failed. The cells stay correct, and the next write of the same row repairs it. */
export class IndexError extends Schema.TaggedError<IndexError>()("IndexError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {}

/** A value SQLite stores in a column. */
type Value = string | number | null

/** The SQL the index runs. D1 runs it in the hub, and SQLite in the tests. */
export interface Database {
  /** Runs one statement that takes no values and returns no rows. */
  readonly exec: (statement: string) => Promise<void>
  /** Runs one statement with its values in the order of its `?1`, `?2` placeholders. */
  readonly run: (statement: string, values: ReadonlyArray<Value>) => Promise<void>
  /** The rows of a query, each a record of its selected columns. */
  readonly all: (query: string) => Promise<ReadonlyArray<Readonly<Record<string, Value>>>>
}

/** What a task row holds beside its own columns, stored as JSON. */
const TaskDetail = Schema.Struct({
  sessions: Schema.Array(Schema.String),
  running: Schema.Array(Schema.String),
  subagents: Schema.Array(Schema.Struct({ session: Schema.String, kind: Schema.String })),
  questions: Schema.Array(Schema.Struct({ id: Schema.String, kind: Schema.String, title: Schema.String })),
  // Rows of tasks that never followed a resource lack the next two keys.
  attachments: Schema.Array(
    Schema.Struct({
      resource: Schema.String,
      relation: Schema.String,
      status: Schema.String,
      note: Schema.String,
      /** `merged` or `closed` once the resource has ended. */
      ended: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
    }),
  ).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  /** Wake-ups that have not reached a session yet. */
  undelivered: Schema.Number.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
})

const TaskDetailJson = Schema.fromJsonString(TaskDetail)

const TaskRecord = Schema.Struct({
  id: TaskId,
  parent: Schema.NullOr(TaskId),
  title: Schema.String,
  /** What the board shows: NeedsMe, Working, Watching or Idle. */
  state: Schema.String,
  detail: TaskDetailJson,
})

/** A task as the board lists it. */
export interface TaskRow extends Schema.Schema.Type<typeof TaskDetail> {
  readonly id: TaskId
  readonly parent: TaskId | null
  readonly title: string
  /** What the board shows: NeedsMe, Working, Watching or Idle. */
  readonly state: string
}

/** A task with the tasks below it. */
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

const PullRequestRecord = Schema.Struct({
  key: PullRequestKey,
  state: Schema.String,
  title: Schema.String,
  detail: PullRequestDetailJson,
})

/** A pull request as the board lists it. */
export type PullRequestRow = typeof PullRequestRecord.Type

/** The read model of the hub: tasks and pull requests as rows the board can list and query. */
export interface Interface {
  /** Writes a task's row. A task that does not exist yet has no row. */
  readonly putTask: (id: TaskId, state: TaskState) => Effect.Effect<void, IndexError>
  /** Writes a pull request's row. One that nobody follows and GitHub never showed has no row. */
  readonly putPullRequest: (key: PullRequestKey, state: PullRequestState) => Effect.Effect<void, IndexError>
  /** Every task as a forest. A task whose parent is missing from the index is a root. */
  readonly tree: Effect.Effect<ReadonlyArray<TaskNode>, IndexError>
  /** The pull requests, the latest change first. `watched` keeps those someone follows that can still change. */
  readonly pullRequests: (which: "all" | "watched") => Effect.Effect<ReadonlyArray<PullRequestRow>, IndexError>
  /** The tasks that hold wake-ups no session has received. */
  readonly tasksWithUndelivered: Effect.Effect<ReadonlyArray<TaskId>, IndexError>
}

/** The hub's read model. */
export class Service extends Context.Service<Service, Interface>()("@ratchet/hub/Index") {}

const tables = [
  "CREATE TABLE IF NOT EXISTS task (id TEXT PRIMARY KEY, parent TEXT, title TEXT NOT NULL, state TEXT NOT NULL, detail TEXT NOT NULL, updated_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS pull_request (key TEXT PRIMARY KEY, state TEXT NOT NULL, title TEXT NOT NULL, detail TEXT NOT NULL, watched INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
]

const failed = (operation: string) => (cause: unknown) => new IndexError({ operation, cause })

/**
 * Builds the read model on a database.
 *
 * The tables are created on first use, not here, so a database that is down does not stop the hub from
 * starting.
 */
export const make = (database: Database): Effect.Effect<Interface> =>
  Effect.gen(function* () {
    const created = yield* Ref.make(false)

    const run = <A>(operation: string, query: () => Promise<A>) =>
      Effect.gen(function* () {
        if (!(yield* Ref.get(created))) {
          for (const table of tables) {
            yield* Effect.tryPromise({ try: () => database.exec(table), catch: failed("create tables") })
          }

          yield* Ref.set(created, true)
        }

        return yield* Effect.tryPromise({ try: query, catch: failed(operation) })
      })

    const putTask = Effect.fn("Index.putTask")(function* (id: TaskId, state: TaskState) {
      if (isUnborn(state)) return

      const detail = yield* Schema.encodeEffect(TaskDetailJson)({
        sessions: state.sessions,
        running: state.running,
        subagents: state.subagents.map(({ session, kind }) => ({ session, kind })),
        questions: state.questions.map(({ id, kind, title }) => ({ id, kind, title })),
        attachments: state.attachments.map(({ resource, relation, status, note, ended }) => ({
          resource,
          relation,
          status,
          note,
          ended,
        })),
        undelivered: state.outbox.length,
      }).pipe(Effect.mapError(failed("put task")))

      const now = yield* Clock.currentTimeMillis
      yield* run("put task", () =>
        database.run(
          `INSERT INTO task (id, parent, title, state, detail, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
           ON CONFLICT (id) DO UPDATE SET parent = excluded.parent, title = excluded.title, state = excluded.state,
             detail = excluded.detail, updated_at = excluded.updated_at`,
          [id, state.parent, state.title, state._tag, detail, now],
        ),
      )
    })

    const putPullRequest = Effect.fn("Index.putPullRequest")(function* (key: PullRequestKey, state: PullRequestState) {
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

      // A pull request nobody follows and GitHub never showed is one that was registered by mistake.
      if (subscribers.length === 0 && row.title === "" && row.canChange) {
        return yield* run("forget pull request", () => database.run("DELETE FROM pull_request WHERE key = ?1", [key]))
      }

      // A pull request is worth reading again while someone follows it and it can still change.
      const watched = subscribers.length > 0 && row.canChange ? 1 : 0

      const detail = yield* Schema.encodeEffect(PullRequestDetailJson)(row.detail).pipe(
        Effect.mapError(failed("put pull request")),
      )

      const now = yield* Clock.currentTimeMillis
      yield* run("put pull request", () =>
        database.run(
          `INSERT INTO pull_request (key, state, title, detail, watched, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
           ON CONFLICT (key) DO UPDATE SET state = excluded.state, title = excluded.title, detail = excluded.detail,
             watched = excluded.watched, updated_at = excluded.updated_at`,
          [key, state._tag, row.title, detail, watched, now],
        ),
      )
    })

    const tree = run("tree", () =>
      database.all("SELECT id, parent, title, state, detail FROM task ORDER BY updated_at DESC"),
    ).pipe(
      Effect.flatMap((rows) =>
        Schema.decodeUnknownEffect(Schema.Array(TaskRecord))(rows).pipe(Effect.mapError(failed("tree"))),
      ),
      Effect.map((records) => {
        const rows = records.map(({ detail, ...row }): TaskRow => ({ ...row, ...detail }))
        const ids = new Set<string>(rows.map((row) => row.id))
        const byParent = new Map<TaskId | null, Array<TaskRow>>()

        for (const row of rows) {
          const parent = row.parent !== null && ids.has(row.parent) ? row.parent : null
          const siblings = byParent.get(parent) ?? []
          siblings.push(row)
          byParent.set(parent, siblings)
        }

        const childrenOf = (parent: TaskId | null): Array<TaskNode> =>
          (byParent.get(parent) ?? []).map((row) => ({ ...row, children: childrenOf(row.id) }))

        return childrenOf(null)
      }),
      Effect.withSpan("Index.tree"),
    )

    const pullRequests = Effect.fn("Index.pullRequests")(function* (which: "all" | "watched") {
      const rows = yield* run("pull requests", () =>
        database.all(
          which === "watched"
            ? "SELECT key, state, title, detail FROM pull_request WHERE watched = 1 ORDER BY key"
            : "SELECT key, state, title, detail FROM pull_request ORDER BY updated_at DESC",
        ),
      )

      return yield* Schema.decodeUnknownEffect(Schema.Array(PullRequestRecord))(rows).pipe(
        Effect.mapError(failed("pull requests")),
      )
    })

    const tasksWithUndelivered = run("undelivered", () =>
      database.all("SELECT id FROM task WHERE json_extract(detail, '$.undelivered') > 0"),
    ).pipe(
      Effect.flatMap((rows) =>
        Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ id: TaskId })))(rows).pipe(
          Effect.mapError(failed("undelivered")),
        ),
      ),
      Effect.map((rows) => rows.map((row) => row.id)),
      Effect.withSpan("Index.tasksWithUndelivered"),
    )

    return Service.of({ putTask, putPullRequest, tree, pullRequests, tasksWithUndelivered })
  })

/** The read model on a database. */
export const layer = (database: Database): Layer.Layer<Service> => Layer.effect(Service, make(database))

/** Runs the index's SQL on a D1 database. */
export const d1 = (db: D1Database): Database => ({
  exec: async (statement) => {
    await db.prepare(statement).run()
  },
  run: async (statement, values) => {
    await db
      .prepare(statement)
      .bind(...values)
      .run()
  },
  all: async (query) => (await db.prepare(query).all<Readonly<Record<string, Value>>>()).results,
})
