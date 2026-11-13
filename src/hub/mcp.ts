import { Effect, Layer, Match, Option, Result, Schema } from "effect"
import { McpProtocol, McpSchema, McpServer, Tool, Toolkit } from "effect/ai"
import { HttpRouter } from "effect/http"
import type { Env } from "../env.ts"
import { causeText } from "../failure.ts"
import { SessionId } from "../protocol/ids.ts"
import { PullRequestRef, Relation } from "../protocol/pull-request.ts"
import type { CellUnavailable } from "./cells.ts"
import { type Services, runtime } from "./cluster.ts"
import type { IndexError } from "./index-store.ts"
import type { PullRequestNotFound, PullRequestUnreadable } from "./pull-request-source.ts"
import * as PullRequests from "./pull-requests.ts"
import type { SessionControlFailed } from "./session-control.ts"
import { SubagentKind } from "./task.ts"
import * as Tasks from "./tasks.ts"

const instructions = `Ratchet tracks this session's work as tasks. A session works on one task at a time.

- When you start on something that is not part of your current task, call task_start first, so the new work is
  recorded as its own task.
- When a significant piece of work can be done separately, call task_fork instead of doing it here. The fork is a
  new session with this session's history. Say in its prompt exactly what it should do. A fork starts in this
  session's directory: when it will edit files, tell it to create a worktree of its own and move there first.
- When you start a subagent that only watches something (metrics, a queue, a rollout) and does no work on the
  task, call subagent_declare with kind "watching". Otherwise the task shows as being worked on for as long as the
  subagent runs.
- When you create a pull request, take one over at the user's request, or wait on one (such as another person's
  base pull request that must merge first), call pr_register. Do not register pull requests you only read or
  discuss. Ratchet follows a registered pull request on GitHub. When pr_register answers "wakes": true, Ratchet
  sends this session a message when something happens that needs action: CI fails or ends, someone reviews it or
  opens a thread, it conflicts, leaves the merge queue, merges or closes. Then do not poll or sleep to watch CI
  or reviews on it: end your turn. When it answers "wakes": false, nothing will wake this session, so watch the
  pull request the way you otherwise would.
- Call pr_set_status whenever the state of your work on a registered pull request changes, and before you end
  your turn: agent-working, waiting-ci, waiting-user (you need the user's answer, review or merge), blocked, or
  ready (nothing is left but merging). The note says in one sentence what you are doing, what blocks it, or what
  you need from the user.`

const Failure = Schema.Struct({ message: Schema.String })

const TaskCurrent = Tool.make("task_current", {
  description: "Show the task this session works on now: its state, parent, subagents and open questions.",
  parameters: Tool.EmptyParams,
  success: Tasks.TaskView,
  failure: Failure,
  failureMode: "return",
  dependencies: [McpSchema.McpRequestContext],
})

const TaskStart = Tool.make("task_start", {
  description:
    "Start a new task and make it this session's current task. Use it when this session begins work that is not part of its current task.",
  parameters: Schema.Struct({
    title: Schema.String.annotate({ description: "A short name for the new task, as it should read on a board." }),
    relation: Tasks.Placement.annotate({
      description:
        "child: the new task came out of the current one. sibling: it is unrelated to the current one and gets the same parent.",
    }),
  }),
  success: Schema.Struct({ task: Tasks.TaskView, left: Tasks.TaskView.fields.id }),
  failure: Failure,
  failureMode: "return",
  dependencies: [McpSchema.McpRequestContext],
})

const TaskRename = Tool.make("task_rename", {
  description:
    "Give a task a new title, as it should read on a board. Without task, it renames the task this session works on now.",
  parameters: Schema.Struct({
    title: Schema.String.annotate({ description: "The new title." }),
    task: Schema.optional(Tasks.TaskView.fields.id).annotate({
      description: "A task this session worked on before, by its ID from pr_list or task_start. Leave it out for the current task.",
    }),
  }),
  success: Tasks.TaskView,
  failure: Failure,
  failureMode: "return",
  dependencies: [McpSchema.McpRequestContext],
})

const TaskFork = Tool.make("task_fork", {
  description:
    "Fork this session into a new session with the same history, as a child task, and prompt the fork. Use it when a significant piece of work can be done separately from what this session does.",
  parameters: Schema.Struct({
    title: Schema.String.annotate({ description: "A short name for the forked task." }),
    prompt: Schema.String.annotate({
      description: "What the fork should do, as its first message. The fork knows this session's history up to now.",
    }),
  }),
  success: Schema.Struct({ session: SessionId }),
  failure: Failure,
  failureMode: "return",
  dependencies: [McpSchema.McpRequestContext],
})

const SubagentDeclare = Tool.make("subagent_declare", {
  description:
    "Say what a running subagent of this session is for. watching: it monitors something and does no work on the task. working: it works on the task (the default).",
  parameters: Schema.Struct({
    session: SessionId.annotate({ description: "The subagent's session ID, starting with ses_." }),
    kind: SubagentKind,
  }),
  success: Tasks.TaskView,
  failure: Failure,
  failureMode: "return",
  dependencies: [McpSchema.McpRequestContext],
})

const reference = {
  owner: PullRequestRef.fields.owner.annotate({ description: "GitHub repository owner." }),
  repo: PullRequestRef.fields.repo.annotate({ description: "GitHub repository name." }),
  number: PullRequestRef.fields.number.annotate({ description: "Pull request number." }),
}

const Registered = PullRequests.Registration

const PrRegister = Tool.make("pr_register", {
  description:
    "Attach a pull request to this session's current task, so Ratchet follows it on GitHub. The answer's wakes field says whether Ratchet will message this session when the pull request needs action. Calling it again keeps the reported work status. It does not change GitHub.",
  parameters: Schema.Struct({
    ...reference,
    relation: Schema.optional(Relation).annotate({
      description:
        "owns (the default): this session drives the pull request to mergeable. waits_on: this task needs it merged and does not work on it; only its merge or close wakes the session. context: related, and nothing about it wakes anyone.",
    }),
  }),
  success: Schema.Struct({ ...Registered.fields, wakes: Schema.Boolean }),
  failure: Failure,
  failureMode: "return",
  dependencies: [McpSchema.McpRequestContext],
})

const PrSetStatus = Tool.make("pr_set_status", {
  description:
    "Report where this session's work on a registered pull request stands, and the next action or blocker. waiting-user puts the task in front of the user. It does not change GitHub.",
  parameters: Schema.Struct({
    ...reference,
    state: Schema.Literals(["agent-working", "waiting-ci", "waiting-user", "blocked", "ready"]),
    note: Schema.String.annotate({
      description: "What is happening, what blocks progress, or the action needed from the user. One sentence.",
    }),
  }),
  success: Registered,
  failure: Failure,
  failureMode: "return",
  dependencies: [McpSchema.McpRequestContext],
})

const PrList = Tool.make("pr_list", {
  description:
    "List the pull requests the tasks of this session follow, on its current task and on tasks it worked on before: the task, the relation, the last reported work status, and what GitHub last said (CI, review decision, conflict, merge queue, open threads).",
  parameters: Tool.EmptyParams,
  success: PullRequests.Following,
  failure: Failure,
  failureMode: "return",
  dependencies: [McpSchema.McpRequestContext],
})

const PrUnregister = Tool.make("pr_unregister", {
  description:
    "Stop this session's current task following a pull request that was registered by mistake or no longer matters to it. It does not close or change the pull request.",
  parameters: Schema.Struct(reference),
  success: Registered,
  failure: Failure,
  failureMode: "return",
  dependencies: [McpSchema.McpRequestContext],
})

const SessionTools = Toolkit.make(
  TaskCurrent,
  TaskStart,
  TaskRename,
  TaskFork,
  SubagentDeclare,
  PrRegister,
  PrSetStatus,
  PrList,
  PrUnregister,
)

const CallerMetadata = Schema.Struct({ "ai.opencode/sessionID": SessionId })

/** The OpenCode session that made the request. OpenCode sends it in the request's metadata, not as an argument. */
const caller = Effect.flatMap(McpSchema.McpRequestContext, (context) =>
  Option.match(Schema.decodeUnknownOption(CallerMetadata)(context.requestMetadata), {
    onNone: () =>
      Effect.fail({ message: "This tool works only from an OpenCode session: the request carries no session ID." }),
    onSome: (metadata) => Effect.succeed(metadata["ai.opencode/sessionID"]),
  }),
)

/** The hub's runtime could not be built or did not run the operation. */
class HubDown extends Schema.TaggedError<HubDown>()("HubDown", { cause: Schema.Defect() }) {
  override get message(): string {
    return `Ratchet is not running: ${causeText(this.cause)}`
  }
}

type ToolFailure =
  | Tasks.NoTask
  | Tasks.NotATaskOfSession
  | PullRequests.NotRegistered
  | PullRequestNotFound
  | PullRequestUnreadable
  | SessionControlFailed
  | CellUnavailable
  | IndexError
  | HubDown

/** What a session reads when a tool fails: what went wrong and what it can do about it. */
const explain = Match.type<ToolFailure>().pipe(
  Match.tagsExhaustive({
    NoTask: ({ session }) =>
      `Ratchet has no task for session ${session} yet. It learns about a session within seconds of its first message.`,
    NotATaskOfSession: ({ task }) => `This session has not worked on ${task}, so it cannot rename it.`,
    NotRegistered: ({ pullRequest }) =>
      `${pullRequest} is not registered on a task of this session. Call pr_register first.`,
    PullRequestNotFound: ({ pullRequest }) =>
      `GitHub has no pull request ${pullRequest}, or Ratchet cannot see it. It is not registered.`,
    PullRequestUnreadable: ({ pullRequest }) =>
      `${pullRequest} is registered, but GitHub could not be read just now. Ratchet reads it again within a minute.`,
    SessionControlFailed: (failure) => failure.message,
    CellUnavailable: (failure) => `${failure.message}. Try again.`,
    IndexError: (failure) => `${failure.message}. The change itself is recorded.`,
    HubDown: (failure) => failure.message,
  }),
)

const handlers = (env: Env) => {
  /** Runs one operation of the hub on its runtime in this isolate, and puts a failure into words. */
  const run = <A, E extends ToolFailure>(operation: Effect.Effect<A, E, Services>) =>
    Effect.tryPromise({
      try: () => runtime(env).then((hub) => hub.runPromise(Effect.result(operation))),
      catch: (cause) => new HubDown({ cause }),
    }).pipe(
      Effect.flatMap((result) => (Result.isSuccess(result) ? Effect.succeed(result.success) : Effect.fail(result.failure))),
      Effect.mapError((failure) => ({ message: explain(failure) })),
    )

  const tasks = <A, E extends ToolFailure>(use: (tasks: Tasks.Interface, session: SessionId) => Effect.Effect<A, E>) =>
    Effect.flatMap(caller, (session) => run(Effect.flatMap(Tasks.Service, (service) => use(service, session))))

  const pullRequests = <A, E extends ToolFailure>(
    use: (pullRequests: PullRequests.Interface, session: SessionId) => Effect.Effect<A, E>,
  ) => Effect.flatMap(caller, (session) => run(Effect.flatMap(PullRequests.Service, (service) => use(service, session))))

  return SessionTools.toLayer(
    SessionTools.of({
      task_current: () => tasks((service, session) => service.current(session)),
      task_start: ({ title, relation }) => tasks((service, session) => service.start(session, title, relation)),
      task_rename: ({ title, task }) =>
        tasks((service, session) => service.rename(session, title, Option.fromUndefinedOr(task))),
      task_fork: ({ title, prompt }) =>
        tasks((service, session) => Effect.map(service.fork(session, title, prompt), (fork) => ({ session: fork }))),
      subagent_declare: ({ session: subagent, kind }) =>
        tasks((service, session) => service.declareSubagent(session, subagent, kind)),
      pr_register: ({ owner, repo, number, relation }) =>
        pullRequests((service, session) => service.register(session, { owner, repo, number }, relation ?? "owns")),
      pr_set_status: ({ owner, repo, number, state, note }) =>
        pullRequests((service, session) => service.setStatus(session, { owner, repo, number }, state, note)),
      pr_list: () => pullRequests((service, session) => service.list(session)),
      pr_unregister: ({ owner, repo, number }) =>
        pullRequests((service, session) => service.unregister(session, { owner, repo, number })),
    }),
  )
}

const layer = (env: Env) =>
  McpServer.layerHttpRequestScoped({
    name: "ratchet",
    version: "0.1.0",
    instructions,
    path: "/mcp",
    protocols: [McpProtocol.v2026_07_28],
    registrations: McpServer.toolkit(SessionTools).pipe(Layer.provide(handlers(env))),
  })

let web: ((request: Request) => Promise<Response>) | undefined

/** Serves the hub's MCP endpoint, the tools sessions call. */
export const handle = (env: Env, request: Request): Promise<Response> => {
  web ??= HttpRouter.toWebHandler(layer(env)).handler

  return web(request)
}
