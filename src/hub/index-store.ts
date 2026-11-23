import { Clock, Context, Effect, Layer, Ref, Schema } from "effect"
import { causeText } from "../failure.ts"
import { DecisionId, DecisionKind, DecisionSpec, Ending } from "../protocol/decision.ts"
import { SessionId, TaskId } from "../protocol/ids.ts"
import { type Outcome, ResourceKey } from "../protocol/resource.ts"
import * as CommitBuilds from "./commit-builds.ts"
import * as CommitRuns from "./commit-runs.ts"
import { type DecisionState, isOpen, isUnraised } from "./decision.ts"
import * as Incident from "./incident.ts"
import * as LinearIssue from "./linear-issue.ts"
import { PullRequestState, failedChecks, outcomeOf } from "./pull-request.ts"
import type { Subscriber } from "./subscribers.ts"
import { type TaskState, isUnborn } from "./task.ts"

/** The read model failed. The cells stay correct, and the next write of the same row repairs it. */
export class IndexError extends Schema.TaggedError<IndexError>()("IndexError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `the index failed to ${this.operation}: ${causeText(this.cause)}`
  }
}

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
  questions: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      kind: Schema.String,
      title: Schema.String,
      /** The session that asks. Rows written before the inbox existed lack it. */
      session: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed(""))),
    }),
  ),
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

/**
 * What a resource row holds beside its own columns, stored as JSON. Which fields are there depends on the
 * kind of resource and on whether its own system has shown it yet.
 */
const ResourceDetail = Schema.Struct({
  head: Schema.optional(Schema.String),
  ci: Schema.optional(Schema.String),
  failed: Schema.optional(Schema.Array(Schema.String)),
  /** The stacks whose run waits for a person. */
  waiting: Schema.optional(Schema.Array(Schema.String)),
  reviewDecision: Schema.optional(Schema.NullOr(Schema.String)),
  conflicting: Schema.optional(Schema.Boolean),
  queued: Schema.optional(Schema.Boolean),
  openThreads: Schema.optional(Schema.Number),
  /** Where a person opens the resource. */
  url: Schema.optional(Schema.String),
  assignee: Schema.optional(Schema.NullOr(Schema.String)),
  severity: Schema.optional(Schema.NullOr(Schema.String)),
  subscribers: Schema.Array(Schema.Struct({ task: Schema.String, relation: Schema.String })),
})

type ResourceDetail = typeof ResourceDetail.Type

const ResourceDetailJson = Schema.fromJsonString(ResourceDetail)

/** The kinds of resource the board lists. */
export const ResourceKind = Schema.Literals(["pull_request", "linear_issue", "incident", "commit_builds", "commit_runs"])

export type ResourceKind = typeof ResourceKind.Type

const ResourceRecord = Schema.Struct({
  key: ResourceKey,
  kind: ResourceKind,
  /** What the board shows: a pull request's state, an issue's workflow state, an incident's status. */
  state: Schema.String,
  title: Schema.String,
  detail: ResourceDetailJson,
})

/** A resource as the board lists it. */
export type ResourceRow = typeof ResourceRecord.Type

/** What a decision row holds beside its own columns, stored as JSON. */
const DecisionDetail = Schema.Struct({
  spec: DecisionSpec,
  ending: Schema.NullOr(Ending),
  raisedAt: Schema.Number,
  closedAt: Schema.NullOr(Schema.Number),
})

const DecisionDetailJson = Schema.fromJsonString(DecisionDetail)

const DecisionRecord = Schema.Struct({
  id: DecisionId,
  task: TaskId,
  /** The task's title, or empty when the task has no row. */
  taskTitle: Schema.String,
  session: SessionId,
  state: Schema.Literals(["Open", "Closed"]),
  detail: DecisionDetailJson,
})

/** A decision as the inbox lists it. */
export interface DecisionRow extends Schema.Schema.Type<typeof DecisionDetail> {
  readonly id: DecisionId
  readonly task: TaskId
  readonly taskTitle: string
  readonly session: SessionId
  readonly state: "Open" | "Closed"
}

/** A question form or a permission request a session waits on, as the inbox lists it. */
export interface QuestionRow {
  readonly id: string
  readonly kind: string
  readonly title: string
  readonly session: string
  readonly task: TaskId
  readonly taskTitle: string
}

/** What waits on me, and what was decided without me. */
export interface Inbox {
  /** Open decisions that a session waits on, the oldest first. */
  readonly waiting: ReadonlyArray<DecisionRow>
  /** Question forms and permission requests, by task. */
  readonly questions: ReadonlyArray<QuestionRow>
  /** Open decisions whose recommended option the session acts on, the oldest first. */
  readonly defaulted: ReadonlyArray<DecisionRow>
  /** The latest closed decisions, the latest first. */
  readonly closed: ReadonlyArray<DecisionRow>
}

/** How many closed decisions the inbox lists. */
const closedShown = 20

/** The read model of the hub: tasks and resources as rows the board can list and query. */
export interface Interface {
  /** Writes a task's row. A task that does not exist yet has no row. */
  readonly putTask: (id: TaskId, state: TaskState) => Effect.Effect<void, IndexError>
  /** Writes a pull request's row. One that nobody follows and GitHub never showed has no row. */
  readonly putPullRequest: (key: ResourceKey, state: PullRequestState) => Effect.Effect<void, IndexError>
  /** Writes a Linear issue's row, under the same rule. */
  readonly putLinearIssue: (key: ResourceKey, state: LinearIssue.LinearIssueState) => Effect.Effect<void, IndexError>
  /** Writes an incident's row, under the same rule. */
  readonly putIncident: (key: ResourceKey, state: Incident.IncidentState) => Effect.Effect<void, IndexError>
  /** Writes the row of a commit's builds, under the same rule. `failed` lists the pipelines whose build failed. */
  readonly putCommitBuilds: (key: ResourceKey, state: CommitBuilds.CommitBuildsState) => Effect.Effect<void, IndexError>
  /** Writes the row of a commit's runs, under the same rule. `waiting` and `failed` list the stacks whose run does. */
  readonly putCommitRuns: (key: ResourceKey, state: CommitRuns.CommitRunsState) => Effect.Effect<void, IndexError>
  /** Every task as a forest. A task whose parent is missing from the index is a root. */
  readonly tree: Effect.Effect<ReadonlyArray<TaskNode>, IndexError>
  /** The resources, the latest change first. `watched` keeps those someone follows that can still change. */
  readonly resources: (which: "all" | "watched") => Effect.Effect<ReadonlyArray<ResourceRow>, IndexError>
  /** The tasks that hold wake-ups no session has received. */
  readonly tasksWithUndelivered: Effect.Effect<ReadonlyArray<TaskId>, IndexError>
  /** Writes a decision's row. A decision that was never raised has no row. */
  readonly putDecision: (id: DecisionId, state: DecisionState) => Effect.Effect<void, IndexError>
  readonly inbox: Effect.Effect<Inbox, IndexError>
}

/** The hub's read model. */
export class Service extends Context.Service<Service, Interface>()("@ratchet/hub/Index") {}

const tables = [
  "CREATE TABLE IF NOT EXISTS task (id TEXT PRIMARY KEY, parent TEXT, title TEXT NOT NULL, state TEXT NOT NULL, detail TEXT NOT NULL, updated_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS pull_request (key TEXT PRIMARY KEY, state TEXT NOT NULL, title TEXT NOT NULL, detail TEXT NOT NULL, watched INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS resource (key TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL, title TEXT NOT NULL, detail TEXT NOT NULL, watched INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
  // Pull requests had a table of their own before other kinds of resource existed. Its rows are copied once.
  "INSERT OR IGNORE INTO resource (key, kind, state, title, detail, watched, updated_at) SELECT key, 'pull_request', state, title, detail, watched, updated_at FROM pull_request",
  "CREATE TABLE IF NOT EXISTS decision (id TEXT PRIMARY KEY, task TEXT NOT NULL, session TEXT NOT NULL, state TEXT NOT NULL, waits INTEGER NOT NULL, detail TEXT NOT NULL, raised_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
]

/** A resource's row before it is stored. */
interface Entry {
  readonly kind: ResourceKind
  readonly state: string
  readonly title: string
  /** Whether the resource's own system has shown it. */
  readonly seen: boolean
  readonly outcome: Outcome | null
  readonly subscribers: ReadonlyArray<Subscriber>
  readonly detail: Omit<ResourceDetail, "subscribers">
}

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
        questions: state.questions.map(({ id, kind, title, session }) => ({ id, kind, title, session })),
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

    const putResource = Effect.fn("Index.putResource")(function* (key: ResourceKey, entry: Entry) {
      // A resource nobody follows and its own system never showed is one that was registered by mistake.
      if (entry.subscribers.length === 0 && !entry.seen) {
        return yield* run("forget resource", () => database.run("DELETE FROM resource WHERE key = ?1", [key]))
      }

      const detail = yield* Schema.encodeEffect(ResourceDetailJson)({
        ...entry.detail,
        subscribers: entry.subscribers.map(({ task, relation }) => ({ task, relation })),
      }).pipe(Effect.mapError(failed("put resource")))

      // A resource is worth reading again while someone follows it and it can still change.
      const watched = entry.subscribers.length > 0 && entry.outcome === null ? 1 : 0
      const now = yield* Clock.currentTimeMillis
      yield* run("put resource", () =>
        database.run(
          `INSERT INTO resource (key, kind, state, title, detail, watched, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
           ON CONFLICT (key) DO UPDATE SET kind = excluded.kind, state = excluded.state, title = excluded.title,
             detail = excluded.detail, watched = excluded.watched, updated_at = excluded.updated_at`,
          [key, entry.kind, entry.state, entry.title, detail, watched, now],
        ),
      )
    })

    const putPullRequest = (key: ResourceKey, state: PullRequestState) =>
      putResource(key, {
        kind: "pull_request",
        state: state._tag,
        subscribers: state.subscribers,
        outcome: outcomeOf(state),
        ...PullRequestState.$match<Pick<Entry, "title" | "seen" | "detail">>(state, {
          Unseen: () => ({ title: "", seen: false, detail: {} }),
          Merged: ({ title }) => ({ title, seen: true, detail: {} }),
          Closed: ({ title }) => ({ title, seen: true, detail: {} }),
          Open: (open) => ({
            title: open.title,
            seen: true,
            detail: {
              head: open.head,
              ci: open.ci._tag,
              failed: failedChecks(open.ci),
              reviewDecision: open.reviewDecision,
              conflicting: open.conflicting,
              queued: open.queued,
              openThreads: open.threads.filter((thread) => !thread.resolved).length,
            },
          }),
        }),
      })

    const putLinearIssue = (key: ResourceKey, state: LinearIssue.LinearIssueState) =>
      putResource(key, {
        kind: "linear_issue",
        subscribers: state.subscribers,
        outcome: LinearIssue.outcomeOf(state),
        ...LinearIssue.LinearIssueState.$match<Pick<Entry, "state" | "title" | "seen" | "detail">>(state, {
          Unseen: () => ({ state: "Unseen", title: "", seen: false, detail: {} }),
          Seen: ({ issue }) => ({
            state: issue.state.name,
            title: issue.title,
            seen: true,
            detail: { url: issue.url, assignee: issue.assignee?.name ?? null },
          }),
        }),
      })

    const putIncident = (key: ResourceKey, state: Incident.IncidentState) =>
      putResource(key, {
        kind: "incident",
        subscribers: state.subscribers,
        outcome: Incident.outcomeOf(state),
        ...Incident.IncidentState.$match<Pick<Entry, "state" | "title" | "seen" | "detail">>(state, {
          Unseen: () => ({ state: "Unseen", title: "", seen: false, detail: {} }),
          Seen: ({ incident }) => ({
            state: incident.status.name,
            title: incident.name,
            seen: true,
            detail: { url: incident.url, severity: incident.severity },
          }),
        }),
      })

    const putCommitBuilds = (key: ResourceKey, state: CommitBuilds.CommitBuildsState) =>
      putResource(key, {
        kind: "commit_builds",
        state: CommitBuilds.summaryOf(state),
        subscribers: state.subscribers,
        outcome: CommitBuilds.outcomeOf(state),
        detail: { failed: CommitBuilds.failedPipelines(state) },
        ...CommitBuilds.CommitBuildsState.$match<Pick<Entry, "title" | "seen">>(state, {
          Unseen: () => ({ title: "", seen: false }),
          Building: ({ title }) => ({ title, seen: true }),
          Settled: ({ title }) => ({ title, seen: true }),
        }),
      })

    const putCommitRuns = (key: ResourceKey, state: CommitRuns.CommitRunsState) =>
      putResource(key, {
        kind: "commit_runs",
        state: CommitRuns.summaryOf(state),
        subscribers: state.subscribers,
        outcome: CommitRuns.outcomeOf(state),
        detail: CommitRuns.attentionOf(state),
        ...CommitRuns.CommitRunsState.$match<Pick<Entry, "title" | "seen">>(state, {
          Unseen: () => ({ title: "", seen: false }),
          Running: ({ title }) => ({ title, seen: true }),
          Settled: ({ title }) => ({ title, seen: true }),
        }),
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

    const resources = Effect.fn("Index.resources")(function* (which: "all" | "watched") {
      const rows = yield* run("resources", () =>
        database.all(
          which === "watched"
            ? "SELECT key, kind, state, title, detail FROM resource WHERE watched = 1 ORDER BY key"
            : "SELECT key, kind, state, title, detail FROM resource ORDER BY updated_at DESC",
        ),
      )

      return yield* Schema.decodeUnknownEffect(Schema.Array(ResourceRecord))(rows).pipe(
        Effect.mapError(failed("resources")),
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

    const putDecision = Effect.fn("Index.putDecision")(function* (id: DecisionId, state: DecisionState) {
      if (isUnraised(state)) return
      const closed = isOpen(state) ? null : state

      const detail = yield* Schema.encodeEffect(DecisionDetailJson)({
        spec: state.spec,
        ending: closed?.ending ?? null,
        raisedAt: state.raisedAt,
        closedAt: closed?.closedAt ?? null,
      }).pipe(Effect.mapError(failed("put decision")))

      const now = yield* Clock.currentTimeMillis
      const waits = DecisionKind.guards.Waits(state.spec.kind) ? 1 : 0
      yield* run("put decision", () =>
        database.run(
          `INSERT INTO decision (id, task, session, state, waits, detail, raised_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
           ON CONFLICT (id) DO UPDATE SET state = excluded.state, detail = excluded.detail, updated_at = excluded.updated_at`,
          [id, state.task, state.session, state._tag, waits, detail, state.raisedAt, now],
        ),
      )
    })

    const decisionRows = (where: string) =>
      run("decisions", () =>
        database.all(
          `SELECT d.id, d.task, coalesce(t.title, '') AS taskTitle, d.session, d.state, d.detail
           FROM decision d LEFT JOIN task t ON t.id = d.task ${where}`,
        ),
      ).pipe(
        Effect.flatMap((rows) =>
          Schema.decodeUnknownEffect(Schema.Array(DecisionRecord))(rows).pipe(Effect.mapError(failed("decisions"))),
        ),
        Effect.map((records) => records.map(({ detail, ...row }): DecisionRow => ({ ...row, ...detail }))),
      )

    const inbox = Effect.gen(function* () {
      const asking = yield* run("questions", () =>
        database.all(
          "SELECT id, title, detail FROM task WHERE json_array_length(detail, '$.questions') > 0 ORDER BY updated_at",
        ),
      )

      const tasks = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ id: TaskId, title: Schema.String, detail: TaskDetailJson })))(asking).pipe(
        Effect.mapError(failed("questions")),
      )

      return {
        waiting: yield* decisionRows("WHERE d.state = 'Open' AND d.waits = 1 ORDER BY d.raised_at"),
        questions: tasks.flatMap((task) =>
          task.detail.questions.map((question) => ({ ...question, task: task.id, taskTitle: task.title })),
        ),
        defaulted: yield* decisionRows("WHERE d.state = 'Open' AND d.waits = 0 ORDER BY d.raised_at"),
        closed: yield* decisionRows(`WHERE d.state = 'Closed' ORDER BY d.updated_at DESC LIMIT ${closedShown}`),
      }
    }).pipe(Effect.withSpan("Index.inbox"))

    return Service.of({
      putDecision,
      inbox,
      putTask,
      putPullRequest,
      putLinearIssue,
      putIncident,
      putCommitBuilds,
      putCommitRuns,
      tree,
      resources,
      tasksWithUndelivered,
    })
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
