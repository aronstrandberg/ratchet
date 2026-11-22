import { Clock, Context, Effect, Layer, Option, Random, Schema } from "effect"
import {
  Answer,
  AnsweredIn,
  DecisionId,
  DecisionKind,
  DecisionSpec,
  Ending,
  confirmsDefault,
  problemOf,
} from "../protocol/decision.ts"
import type { SessionId, TaskId } from "../protocol/ids.ts"
import * as Cells from "./cells.ts"
import { DecisionEvent, type DecisionState, isOpen, isUnraised } from "./decision.ts"
import type { IndexError } from "./index-store.ts"
import { TaskEvent, isUnborn } from "./task.ts"
import * as Tasks from "./tasks.ts"
import * as Wakes from "./wakes.ts"

/** A spec that the schema admits but that cannot be raised, such as one whose recommended option is not an option. */
export class InvalidDecision extends Schema.TaggedError<InvalidDecision>()("InvalidDecision", {
  problem: Schema.String,
}) {
  override get message(): string {
    return `the decision cannot be raised: ${this.problem}`
  }
}

/** No decision has this ID. */
export class UnknownDecision extends Schema.TaggedError<UnknownDecision>()("UnknownDecision", { id: DecisionId }) {
  override get message(): string {
    return `there is no decision ${this.id}`
  }
}

/** The decision has closed already, so it takes no answer and cannot be superseded or withdrawn. */
export class DecisionClosed extends Schema.TaggedError<DecisionClosed>()("DecisionClosed", {
  id: DecisionId,
  ending: Ending,
}) {
  override get message(): string {
    return `decision ${this.id} has closed already (${this.ending._tag})`
  }
}

/** The decision belongs to a task the session has not worked on. */
export class NotADecisionOfSession extends Schema.TaggedError<NotADecisionOfSession>()("NotADecisionOfSession", {
  id: DecisionId,
}) {
  override get message(): string {
    return `decision ${this.id} belongs to a task this session has not worked on`
  }
}

/** An answer named an option the decision does not have. */
export class UnknownOption extends Schema.TaggedError<UnknownOption>()("UnknownOption", {
  id: DecisionId,
  option: Schema.String,
  options: Schema.Array(Schema.String),
}) {
  override get message(): string {
    return `decision ${this.id} has no option "${this.option}". Its options are ${this.options.map((label) => `"${label}"`).join(", ")}`
  }
}

/** A decision a session raised, and what the session is to do now. */
export const Raised = Schema.Struct({
  decision: DecisionId,
  task: Schema.String,
  /** What the session does until an answer arrives. */
  meanwhile: Schema.String,
})

export type Raised = typeof Raised.Type

type Failure = Cells.CellUnavailable | IndexError

/** Questions sessions put to me, answered in the inbox or in the session's own window. */
export interface Interface {
  /**
   * Raises a decision on the session's current task. With `supersedes`, an open decision of the same task
   * closes in favour of the new one.
   */
  readonly raise: (
    session: SessionId,
    spec: DecisionSpec,
    supersedes: Option.Option<DecisionId>,
  ) => Effect.Effect<Raised, InvalidDecision | UnknownDecision | DecisionClosed | NotADecisionOfSession | Tasks.NoTask | Failure>
  /**
   * Answers an open decision from the inbox. The session is woken with the answer, unless the answer
   * confirms the option it already acts on.
   */
  readonly answer: (
    id: DecisionId,
    answer: Answer,
    note: string,
  ) => Effect.Effect<void, UnknownDecision | DecisionClosed | UnknownOption | Failure>
  /**
   * Closes an open decision of one of the session's tasks: answered in the session's own window when an
   * option is given, withdrawn otherwise.
   */
  readonly close: (
    session: SessionId,
    id: DecisionId,
    option: Option.Option<string>,
    reason: string,
  ) => Effect.Effect<void, UnknownDecision | DecisionClosed | NotADecisionOfSession | UnknownOption | Tasks.NoTask | Failure>
}

/** The hub's decisions. */
export class Service extends Context.Service<Service, Interface>()("@ratchet/hub/Decisions") {}

const hex = (word: number) => word.toString(16).padStart(8, "0")

/** A new decision ID: `dec_` and 24 random hex digits. */
const newDecisionId = Effect.map(
  Effect.all([0, 1, 2].map(() => Random.nextIntBetween(0, 0xffff_ffff))),
  (words) => DecisionId.make(`dec_${words.map(hex).join("")}`),
)

const meanwhileOf = (spec: DecisionSpec) =>
  DecisionKind.match(spec.kind, {
    Reversible: () =>
      `Act on "${spec.recommended}" now. If the user chooses another option, Ratchet messages this session, and you undo it as you said.`,
    Waits: () =>
      "Do nothing that depends on this choice until Ratchet messages this session with the answer. Work on something else, or end your turn.",
  })

/** The message that brings my answer to the session that asked. */
const answerText = (id: DecisionId, spec: DecisionSpec, answer: Answer, note: string, task: string) => {
  const given = Answer.match(answer, {
    Chose: ({ option }) => `- The user chose "${option}".`,
    Wrote: ({ text }) => `- The user answered in their own words: ${text}`,
  })

  const next = DecisionKind.match(spec.kind, {
    Reversible: ({ undo }) =>
      `You acted on "${spec.recommended}" meanwhile. Undo that as you said (${undo}), then act on this answer.`,
    Waits: ({ blocks }) => `Go on with what waited on this answer: ${blocks}`,
  })

  return [
    `Ratchet: the user answered your decision "${spec.question}" (${id}).`,
    given,
    ...(note === "" ? [] : [`- Their note: ${note}`]),
    next,
    `It belongs to your task "${task}".`,
  ].join("\n")
}

/** Builds the decisions on the cells, the tasks and the messages to sessions. */
export const make = Effect.gen(function* () {
  const cells = yield* Cells.Service
  const tasks = yield* Tasks.Service
  const wakes = yield* Wakes.Service

  /** An open decision, or why it cannot be acted on. */
  const openDecision = Effect.fn("Decisions.open")(function* (id: DecisionId) {
    const state: DecisionState = yield* cells.decision(id)

    if (isUnraised(state)) return yield* new UnknownDecision({ id })

    if (!isOpen(state)) return yield* new DecisionClosed({ id, ending: state.ending })

    return state
  })

  const ofSession = Effect.fn("Decisions.ofSession")(function* (session: SessionId, id: DecisionId) {
    const decision = yield* openDecision(id)

    if (!(yield* tasks.tasksOf(session)).includes(decision.task)) return yield* new NotADecisionOfSession({ id })

    return decision
  })

  const end = Effect.fn("Decisions.end")(function* (id: DecisionId, task: TaskId, ending: Ending) {
    yield* cells.sendDecision(id, DecisionEvent.Closed({ ending, at: yield* Clock.currentTimeMillis }))
    yield* cells.sendTask(task, TaskEvent.DecisionClosed({ id }))
  })

  const known = (id: DecisionId, spec: DecisionSpec, answer: Answer) => {
    const labels = spec.options.map((option) => option.label)

    return Answer.guards.Chose(answer) && !labels.includes(answer.option)
      ? Effect.fail(new UnknownOption({ id, option: answer.option, options: labels }))
      : Effect.void
  }

  const raise = Effect.fn("Decisions.raise")(function* (
    session: SessionId,
    spec: DecisionSpec,
    supersedes: Option.Option<DecisionId>,
  ) {
    const problem = problemOf(spec)

    if (problem !== null) return yield* new InvalidDecision({ problem })
    const task = yield* tasks.taskOf(session)
    const id = yield* newDecisionId

    if (Option.isSome(supersedes)) {
      const old = yield* ofSession(session, supersedes.value)

      if (old.task !== task) return yield* new NotADecisionOfSession({ id: supersedes.value })
      yield* end(supersedes.value, task, Ending.cases.Superseded.make({ by: id }))
    }

    yield* cells.sendDecision(id, DecisionEvent.Raised({ spec, task, session, at: yield* Clock.currentTimeMillis }))
    const waits = DecisionKind.guards.Waits(spec.kind)
    yield* cells.sendTask(task, TaskEvent.DecisionOpened({ id, question: spec.question, waits }))

    return { decision: id, task, meanwhile: meanwhileOf(spec) }
  })

  const answer = Effect.fn("Decisions.answer")(function* (id: DecisionId, given: Answer, note: string) {
    const decision = yield* openDecision(id)
    yield* known(id, decision.spec, given)
    yield* end(id, decision.task, Ending.cases.Answered.make({ answer: given, note, in: AnsweredIn.make("inbox") }))

    if (confirmsDefault(decision.spec, given)) return
    const task = yield* cells.task(decision.task)
    const title = isUnborn(task) ? decision.task : task.title

    yield* wakes.send(decision.task, {
      id: `${id}:answer`,
      session: decision.session,
      text: answerText(id, decision.spec, given, note, title),
    })
  })

  const close = Effect.fn("Decisions.close")(function* (
    session: SessionId,
    id: DecisionId,
    option: Option.Option<string>,
    reason: string,
  ) {
    const decision = yield* ofSession(session, id)

    const ending = yield* Option.match(option, {
      onNone: () => Effect.succeed(Ending.cases.Withdrawn.make({ reason })),
      onSome: (label) => {
        const given = Answer.cases.Chose.make({ option: label })

        return Effect.as(
          known(id, decision.spec, given),
          Ending.cases.Answered.make({ answer: given, note: reason, in: AnsweredIn.make("session") }),
        )
      },
    })

    yield* end(id, decision.task, ending)
  })

  return Service.of({ raise, answer, close })
})

/** The decisions, still in need of the cells, the tasks and the messages to sessions. */
export const layerWithoutDependencies = Layer.effect(Service, make)
