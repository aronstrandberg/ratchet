import { Effect, Layer, Schema } from "effect"
import { McpProtocol, McpSchema, McpServer, Tool, Toolkit } from "effect/ai"
import { HttpRouter } from "effect/http"
import type { Env } from "../env.ts"
import { runtime } from "./cluster.ts"
import * as Commands from "./commands.ts"

const instructions = `Ratchet tracks this session's work as tasks. A session works on one task at a time.

- When you start on something that is not part of your current task, call task_start first, so the new work is
  recorded as its own task.
- When a significant piece of work can be done separately, call task_fork instead of doing it here. The fork is a
  new session with this session's history. Say in its prompt exactly what it should do. A fork starts in this
  session's directory: when it will edit files, tell it to create a worktree of its own and move there first.
- When you start a subagent that only watches something (metrics, a queue, a rollout) and does no work on the
  task, call subagent_declare with kind "watching". Otherwise the task shows as being worked on for as long as the
  subagent runs.`

const Failure = Schema.Struct({ message: Schema.String })

const TaskCurrent = Tool.make("task_current", {
  description: "Show the task this session works on now: its state, parent, subagents and open questions.",
  parameters: Tool.EmptyParams,
  success: Commands.TaskView,
  failure: Failure,
  failureMode: "return",
  dependencies: [McpSchema.McpRequestContext],
})

const TaskStart = Tool.make("task_start", {
  description:
    "Start a new task and make it this session's current task. Use it when this session begins work that is not part of its current task.",
  parameters: Schema.Struct({
    title: Schema.String.annotate({ description: "A short name for the new task, as it should read on a board." }),
    relation: Schema.Literals(["child", "sibling"]).annotate({
      description:
        "child: the new task came out of the current one. sibling: it is unrelated to the current one and gets the same parent.",
    }),
  }),
  success: Schema.Struct({ task: Commands.TaskView, left: Schema.String }),
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
  success: Schema.Struct({ session: Schema.String }),
  failure: Failure,
  failureMode: "return",
  dependencies: [McpSchema.McpRequestContext],
})

const SubagentDeclare = Tool.make("subagent_declare", {
  description:
    "Say what a running subagent of this session is for. watching: it monitors something and does no work on the task. working: it works on the task (the default).",
  parameters: Schema.Struct({
    session: Schema.String.annotate({ description: "The subagent's session ID, starting with ses_." }),
    kind: Schema.Literals(["working", "watching"]),
  }),
  success: Commands.TaskView,
  failure: Failure,
  failureMode: "return",
  dependencies: [McpSchema.McpRequestContext],
})

const SessionTools = Toolkit.make(TaskCurrent, TaskStart, TaskFork, SubagentDeclare)

/** The OpenCode session that made the request. OpenCode sends it in the request's metadata, not as an argument. */
const caller = Effect.flatMap(McpSchema.McpRequestContext, (context) => {
  const session = context.requestMetadata?.["ai.opencode/sessionID"]
  return typeof session === "string"
    ? Effect.succeed(session)
    : Effect.fail({ message: "This tool works only from an OpenCode session: the request carries no session ID." })
})

const failure = (cause: unknown) => ({
  message:
    cause instanceof Commands.NoTask
      ? `Ratchet has no task for session ${cause.session} yet. It learns about a session within seconds of its first message.`
      : String(cause),
})

const handlers = (env: Env) => {
  /** Runs a hub command on the cluster runtime of this isolate. */
  const run = <A, E>(command: Effect.Effect<A, E, any>) =>
    Effect.tryPromise({
      try: () => runtime(env).then((app) => app.runPromise(command as Effect.Effect<A, E, never>)),
      catch: failure,
    })
  return SessionTools.toLayer(
    SessionTools.of({
      task_current: () => Effect.flatMap(caller, (session) => run(Commands.current(session))),
      task_start: ({ title, relation }) =>
        Effect.gen(function* () {
          const session = yield* caller
          const started = yield* run(Commands.start(env.INDEX, session, title, relation))
          yield* Effect.tryPromise({ try: () => env.GATEWAY.recordTask(session, started.task.id), catch: failure })
          return started
        }),
      task_fork: ({ title, prompt }) =>
        Effect.gen(function* () {
          const session = yield* caller
          const fork = yield* Effect.tryPromise({
            try: () => env.GATEWAY.forkSession(session, title, prompt),
            catch: failure,
          })
          return { session: fork }
        }),
      subagent_declare: ({ session: subagent, kind }) =>
        Effect.flatMap(caller, (session) => run(Commands.declareSubagent(env.INDEX, session, subagent, kind))),
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
