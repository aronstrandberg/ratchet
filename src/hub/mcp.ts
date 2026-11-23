import { Effect, Layer, Match, Option, Result, Schema } from "effect"
import { McpProtocol, McpSchema, McpServer, Tool, Toolkit } from "effect/ai"
import { HttpRouter } from "effect/http"
import type { Env } from "../env.ts"
import { causeText } from "../failure.ts"
import { Answer, Choice, DecisionId, DecisionKind, DecisionSpec } from "../protocol/decision.ts"
import { SessionId } from "../protocol/ids.ts"
import { PullRequestRef } from "../protocol/pull-request.ts"
import { Relation, ResourceRef, parseReference } from "../protocol/resource.ts"
import type { CellUnavailable } from "./cells.ts"
import * as Decisions from "./decisions.ts"
import { type Services, runtime } from "./cluster.ts"
import type { IndexError } from "./index-store.ts"
import type { ResourceNotFound, ResourceNotSignedIn, ResourceUnreadable } from "./resource-source.ts"
import * as Resources from "./resources.ts"
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
  you need from the user.
- A Linear issue or an incident.io incident this session works on, or waits on, is registered the same way:
  call resource_register with its address or its short name (DX-1550, INC-123), and report with
  resource_set_status. The Linear issue a task owns is that task's ticket, and one task at most owns an issue.
  Ratchet messages this session when someone else comments on the issue, when it goes to another person, and
  when the issue or the incident ends.
- When a pull request this session owns merges, Ratchet follows the builds that carry its merge commit on
  the base branch, and messages this session when one of them fails. Such a build often carries other
  people's changes as well. The failure is this session's to look at: read the build, and say so when
  another change caused it.
- Ratchet also follows the Spacelift runs that apply the merged change, on the stacks that planned the pull
  request. It messages this session when a run waits for someone to confirm it or for an approval, fails,
  or is discarded. A run that waits applies a change to real infrastructure: read its plan and tell the
  user what it would change. Confirm it only when the user has asked this session to.
- Decide small details that can be undone yourself, without asking. When a choice is the user's and you
  have a recommendation, call decision_raise instead of the question tool, then tell the user in a sentence
  that you raised it. The user answers in this session or in their coordinator's session, and Ratchet
  messages this session with an answer given elsewhere. A choice that can be undone does not stop you: act
  on your recommendation at once, and undo it if the user chooses otherwise. A choice that cannot be undone
  waits for the answer: changing production, deleting data, sending messages to people, merging, spending
  money, or changing the task's scope or design. Keep the question tool for a turn that cannot go on without
  an answer and where you have no recommendation.
- When the user answers a decision in this session's own window instead, or the question no longer
  matters, call decision_close.
- The user may make one session the coordinator, with inbox_watch. Ratchet then posts each decision there
  when it opens and when it closes, without starting a turn. In that session, show a decision's brief and
  options as Ratchet wrote them, and call decision_answer only with what the user said in this turn. Never
  call inbox_watch or decision_answer on your own.`

const Failure = Schema.Struct({ message: Schema.String })

const TaskCurrent = Tool.make("task_current", {
  description: "Show the task this session works on now: its state, parent, subagents, open questions and open decisions.",
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

const DecisionRaise = Tool.make("decision_raise", {
  description:
    "Ask the user to choose, with your recommendation, on this session's current task. The user answers in Ratchet's inbox, and Ratchet messages this session with the answer. The answer's meanwhile field says what to do until then.",
  parameters: Schema.Struct({
    question: DecisionSpec.fields.question.annotate({ description: "The question, in at most 140 characters." }),
    brief: DecisionSpec.fields.brief.annotate({
      description:
        "Markdown prose that the user reads before the options, written for someone who has not read this session: what the task is, what happened that led to this choice, what is at stake, and why the choice is the user's. Link pull requests, builds and files. At most 4000 characters.",
    }),
    options: Schema.Array(Choice).pipe(Schema.check(Schema.isMinLength(2), Schema.isMaxLength(4))).annotate({
      description:
        "Two to four options. label names the option in at most 80 characters. effect says what changes if it is chosen, what it costs and what can go wrong, in at most 600 characters.",
    }),
    recommended: Schema.String.annotate({ description: "The label of the option you recommend." }),
    reason: DecisionSpec.fields.reason.annotate({ description: "Why you recommend it." }),
    kind: Schema.Union([
      Schema.Struct({
        undo: DecisionKind.cases.Reversible.fields.undo.annotate({
          description: "How you undo the recommended option if the user chooses another.",
        }),
      }),
      Schema.Struct({
        blocks: DecisionKind.cases.Waits.fields.blocks.annotate({
          description: "What cannot go on until the user answers.",
        }),
      }),
    ]).annotate({
      description:
        "{undo}: the choice can be undone, and you act on the recommended option at once. {blocks}: it cannot, and you wait for the answer.",
    }),
    supersedes: Schema.optional(DecisionId).annotate({
      description: "An open decision of this task that this one replaces. It closes.",
    }),
  }),
  success: Decisions.Raised,
  failure: Failure,
  failureMode: "return",
  dependencies: [McpSchema.McpRequestContext],
})

const DecisionClose = Tool.make("decision_close", {
  description:
    "Close an open decision of this session's tasks: with option, the user chose it in this session's own window. Without option, the question no longer matters.",
  parameters: Schema.Struct({
    decision: DecisionId.annotate({ description: "The decision's ID, starting with dec_." }),
    option: Schema.optional(Schema.String).annotate({ description: "The label of the option the user chose here." }),
    reason: Schema.String.annotate({ description: "What the user said, or why the question no longer matters." }),
  }),
  success: Schema.Struct({ decision: DecisionId }),
  failure: Failure,
  failureMode: "return",
  dependencies: [McpSchema.McpRequestContext],
})

const InboxWatch = Tool.make("inbox_watch", {
  description:
    "Make this session the coordinator: Ratchet posts every decision here when it opens and when it closes. Call it only when the user asks. It answers with what waits on the user now.",
  parameters: Schema.Struct({
    replace: Schema.optional(Schema.Boolean).annotate({
      description: "Take the seat from another session. Only when the user asked to move the coordinator here.",
    }),
  }),
  success: Decisions.InboxCards,
  failure: Failure,
  failureMode: "return",
  dependencies: [McpSchema.McpRequestContext],
})

const InboxList = Tool.make("inbox_list", {
  description:
    "List what waits on the user: decisions sessions wait on, open question forms and permission requests, and decisions whose recommended option a session acts on meanwhile.",
  parameters: Tool.EmptyParams,
  success: Decisions.InboxCards,
  failure: Failure,
  failureMode: "return",
  dependencies: [McpSchema.McpRequestContext],
})

const DecisionAnswer = Tool.make("decision_answer", {
  description:
    "Answer a decision for the user, from the coordinator's session only, with what the user said in this turn. Ratchet messages the session that asked, unless the answer confirms the option it already acts on.",
  parameters: Schema.Struct({
    decision: DecisionId.annotate({ description: "The decision's ID, starting with dec_." }),
    option: Schema.optional(Schema.String).annotate({ description: "The label of the option the user chose." }),
    text: Schema.optional(Answer.cases.Wrote.fields.text).annotate({
      description: "The user's answer in their own words, when no option fits. Give option or text.",
    }),
    note: Schema.optional(Schema.String).annotate({ description: "Anything else the user said for that session." }),
  }),
  success: Schema.Struct({ decision: DecisionId }),
  failure: Failure,
  failureMode: "return",
  dependencies: [McpSchema.McpRequestContext],
})

const reference = {
  owner: PullRequestRef.fields.owner.annotate({ description: "GitHub repository owner." }),
  repo: PullRequestRef.fields.repo.annotate({ description: "GitHub repository name." }),
  number: PullRequestRef.fields.number.annotate({ description: "Pull request number." }),
}

const Registered = Resources.Registration

const WorkState = Schema.Literals(["agent-working", "waiting-ci", "waiting-user", "blocked", "ready"])

const resource = Schema.String.annotate({
  description:
    "The resource by its address in a browser or its short name: a pull request (owner/repo#12), a Linear issue (DX-1550) or an incident.io incident (INC-123).",
})

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
    state: WorkState,
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
    "List the pull requests, Linear issues, incidents, builds and infrastructure runs the tasks of this session follow, on its current task and on tasks it worked on before: the task, the relation, the last reported work status, and where each stands in its own system. A pull request also shows what GitHub last said (CI, review decision, conflict, merge queue, open threads). The builds and the Spacelift runs of a commit show how many are in each state.",
  parameters: Tool.EmptyParams,
  success: Resources.Following,
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

const ResourceRegister = Tool.make("resource_register", {
  description:
    "Attach a Linear issue, an incident or a pull request to this session's current task, so Ratchet follows it in its own system. The answer's wakes field says whether Ratchet will message this session when it needs action. One task at most owns a Linear issue: the issue is that task's ticket. It changes nothing in the other system.",
  parameters: Schema.Struct({
    resource,
    relation: Schema.optional(Relation).annotate({
      description:
        "owns (the default): this task is the work on it, and this session drives it. waits_on: this task needs it done and does not work on it; only its end wakes the session. context: related, and nothing about it wakes anyone.",
    }),
  }),
  success: Schema.Struct({ ...Registered.fields, wakes: Schema.Boolean }),
  failure: Failure,
  failureMode: "return",
  dependencies: [McpSchema.McpRequestContext],
})

const ResourceSetStatus = Tool.make("resource_set_status", {
  description:
    "Report where this session's work on a registered resource stands, and the next action or blocker. waiting-user puts the task in front of the user. It changes nothing in the other system.",
  parameters: Schema.Struct({
    resource,
    state: WorkState,
    note: Schema.String.annotate({
      description: "What is happening, what blocks progress, or the action needed from the user. One sentence.",
    }),
  }),
  success: Registered,
  failure: Failure,
  failureMode: "return",
  dependencies: [McpSchema.McpRequestContext],
})

const ResourceUnregister = Tool.make("resource_unregister", {
  description:
    "Stop a task of this session following a resource that was registered by mistake or no longer matters to it. It changes nothing in the other system.",
  parameters: Schema.Struct({ resource }),
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
  ResourceRegister,
  ResourceSetStatus,
  ResourceUnregister,
  DecisionRaise,
  DecisionClose,
  DecisionAnswer,
  InboxWatch,
  InboxList,
)

/** decision_answer was given neither an option nor an answer in words. */
class NoAnswer extends Schema.TaggedError<NoAnswer>()("NoAnswer", {}) {
  override get message(): string {
    return "Give the option the user chose, or their answer as text"
  }
}

/** What a session gave as a resource is none of the kinds Ratchet follows. */
class UnknownReference extends Schema.TaggedError<UnknownReference>()("UnknownReference", { given: Schema.String }) {
  override get message(): string {
    return `Ratchet cannot tell what "${this.given}" is`
  }
}

/** Reads the resource a session named. */
const named = (given: string) =>
  Option.match(parseReference(given), {
    onNone: () => Effect.fail(new UnknownReference({ given })),
    onSome: (ref) => Effect.succeed(ref),
  })

const pullRequest = (ref: PullRequestRef) => ResourceRef.cases.PullRequest.make(ref)

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
  | Resources.NotRegistered
  | Resources.AlreadyOwned
  | Decisions.InvalidDecision
  | Decisions.UnknownDecision
  | Decisions.DecisionClosed
  | Decisions.NotADecisionOfSession
  | Decisions.UnknownOption
  | Decisions.NotCoordinator
  | Decisions.OwnDecision
  | Decisions.SeatTaken
  | NoAnswer
  | UnknownReference
  | ResourceNotFound
  | ResourceNotSignedIn
  | ResourceUnreadable
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
    NotRegistered: ({ resource }) => `${resource} is not registered on a task of this session. Register it first.`,
    AlreadyOwned: ({ resource, owner }) =>
      `${resource} is the ticket of task ${owner} already, and one task at most owns it. Register it with relation waits_on or context, or work in that task.`,
    InvalidDecision: (failure) => `${failure.message}. Fix it and raise it again.`,
    UnknownDecision: (failure) => `${failure.message}. task_current lists the open decisions of this session's task.`,
    DecisionClosed: (failure) => failure.message,
    NotADecisionOfSession: (failure) => failure.message,
    UnknownOption: (failure) => failure.message,
    NotCoordinator: (failure) => `${failure.message}. The user makes a session the coordinator with inbox_watch.`,
    NoAnswer: (failure) => failure.message,
    OwnDecision: (failure) => `${failure.message}, in the session that raised it.`,
    SeatTaken: (failure) =>
      `${failure.message}. Move it here only if the user asked: call inbox_watch again with replace true.`,
    UnknownReference: (failure) =>
      `${failure.message}. Give a pull request, a Linear issue or an incident by its address or its short name, such as owner/repo#12, DX-1550 or INC-123.`,
    ResourceNotFound: (failure) => `${failure.message}. It is not registered.`,
    ResourceNotSignedIn: (failure) =>
      `${failure.message}, so it is not registered. Only the user can sign in: GET /gateway/sign-ins/${failure.system}/login on Ratchet's own address answers with the link to open in a browser. Give the user that link.`,
    ResourceUnreadable: (failure) => `It is registered, but ${failure.message}. Ratchet reads it again within a minute.`,
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

  const resources = <A, E extends ToolFailure>(
    use: (resources: Resources.Interface, session: SessionId) => Effect.Effect<A, E>,
  ) => Effect.flatMap(caller, (session) => run(Effect.flatMap(Resources.Service, (service) => use(service, session))))

  const decisions = <A, E extends ToolFailure>(
    use: (decisions: Decisions.Interface, session: SessionId) => Effect.Effect<A, E>,
  ) => Effect.flatMap(caller, (session) => run(Effect.flatMap(Decisions.Service, (service) => use(service, session))))

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
        resources((service, session) =>
          service.register(session, pullRequest({ owner, repo, number }), relation ?? "owns"),
        ),
      pr_set_status: ({ owner, repo, number, state, note }) =>
        resources((service, session) => service.setStatus(session, pullRequest({ owner, repo, number }), state, note)),
      pr_list: () => resources((service, session) => service.list(session)),
      pr_unregister: ({ owner, repo, number }) =>
        resources((service, session) => service.unregister(session, pullRequest({ owner, repo, number }))),
      resource_register: ({ resource, relation }) =>
        resources((service, session) =>
          Effect.flatMap(named(resource), (ref) => service.register(session, ref, relation ?? "owns")),
        ),
      resource_set_status: ({ resource, state, note }) =>
        resources((service, session) =>
          Effect.flatMap(named(resource), (ref) => service.setStatus(session, ref, state, note)),
        ),
      decision_raise: ({ question, brief, options, recommended, reason, kind, supersedes }) =>
        decisions((service, session) =>
          service.raise(
            session,
            {
              question,
              brief,
              options,
              recommended,
              reason,
              kind:
                "undo" in kind
                  ? DecisionKind.cases.Reversible.make({ undo: kind.undo })
                  : DecisionKind.cases.Waits.make({ blocks: kind.blocks }),
            },
            Option.fromUndefinedOr(supersedes),
          ),
        ),
      decision_close: ({ decision, option, reason }) =>
        decisions((service, session) =>
          Effect.as(service.close(session, decision, Option.fromUndefinedOr(option), reason), { decision }),
        ),
      decision_answer: ({ decision, option, text, note }) =>
        decisions((service, session) => {
          const given: Option.Option<Answer> =
            option !== undefined && option.trim() !== ""
              ? Option.some(Answer.cases.Chose.make({ option: option.trim() }))
              : text !== undefined && text.trim() !== ""
                ? Option.some(Answer.cases.Wrote.make({ text: text.trim() }))
                : Option.none()

          return Effect.gen(function* () {
            if (Option.isNone(given)) return yield* new NoAnswer()
            yield* service.answerAsCoordinator(session, decision, given.value, note ?? "")

            return { decision }
          })
        }),
      inbox_watch: ({ replace }) => decisions((service, session) => service.seat(session, replace ?? false)),
      inbox_list: () => decisions((service) => service.inbox),
      resource_unregister: ({ resource }) =>
        resources((service, session) => Effect.flatMap(named(resource), (ref) => service.unregister(session, ref))),
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
