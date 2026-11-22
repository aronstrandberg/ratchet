import { Clock, Context, Effect, Layer, Option, Random, Schema } from "effect"
import { Card } from "../protocol/card.ts"
import { Answer, AnsweredIn, DecisionId, DecisionKind, DecisionSpec, Ending, confirmsDefault, problemOf } from "../protocol/decision.ts"
import { SessionId, type TaskId } from "../protocol/ids.ts"
import * as Cells from "./cells.ts"
import { seatedSession } from "./coordinator.ts"
import { answerText, cardText, meanwhileOf } from "./decision-text.ts"
import { DecisionEvent, type DecisionState, isOpen, isUnraised } from "./decision.ts"
import * as Index from "./index-store.ts"
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

/** A session that is not the coordinator tried to answer for the user. */
export class NotCoordinator extends Schema.TaggedError<NotCoordinator>()("NotCoordinator", { session: SessionId }) {
  override get message(): string {
    return `session ${this.session} is not the coordinator, so it cannot answer for the user`
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

/** A question form or a permission request a session waits on. */
export const OpenQuestion = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  title: Schema.String,
  session: Schema.String,
  task: Schema.String,
  taskTitle: Schema.String,
})

/** What waits on me, and what took its default, as cards. */
export const InboxCards = Schema.Struct({
  /** Decisions a session waits on, the oldest first. */
  waiting: Schema.Array(Card),
  /** Question forms and permission requests, which are answered in their session. */
  questions: Schema.Array(OpenQuestion),
  /** Decisions whose recommended option the session acts on, the oldest first. */
  defaulted: Schema.Array(Card),
})

export type InboxCards = typeof InboxCards.Type

type Failure = Cells.CellUnavailable | Index.IndexError

/**
 * Questions sessions put to me. I answer in the session that asked, in the coordinator's session, or through
 * the inbox's routes. The coordinator's session hears of each decision when it opens and when it closes.
 */
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
   * Answers an open decision for the user, from the inbox's routes or from the coordinator's session. The
   * session that asked is woken with the answer, unless the answer confirms the option it already acts on.
   */
  readonly answer: (
    id: DecisionId,
    answer: Answer,
    note: string,
    from: AnsweredIn,
  ) => Effect.Effect<void, UnknownDecision | DecisionClosed | UnknownOption | Failure>
  /** Answers as {@link Interface.answer} does, for a session that has to be the coordinator. */
  readonly answerAsCoordinator: (
    session: SessionId,
    id: DecisionId,
    answer: Answer,
    note: string,
  ) => Effect.Effect<void, NotCoordinator | UnknownDecision | DecisionClosed | UnknownOption | Failure>
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
  /** Makes a session the coordinator, which Ratchet tells about every decision from now on. */
  readonly seat: (session: SessionId) => Effect.Effect<InboxCards, Failure>
  readonly inbox: Effect.Effect<InboxCards, Index.IndexError>
}

/** The hub's decisions. */
export class Service extends Context.Service<Service, Interface>()("@ratchet/hub/Decisions") {}

const hex = (word: number) => word.toString(16).padStart(8, "0")

/** A new decision ID: `dec_` and 24 random hex digits. */
const newDecisionId = Effect.map(
  Effect.all([0, 1, 2].map(() => Random.nextIntBetween(0, 0xffff_ffff))),
  (words) => DecisionId.make(`dec_${words.map(hex).join("")}`),
)

const cardOfRow = (row: Index.DecisionRow): Card =>
  Card.cases.Decision.make({
    id: row.id,
    task: row.task,
    taskTitle: row.taskTitle || row.task,
    session: row.session,
    spec: row.spec,
    ending: row.ending,
  })

/** Builds the decisions on the cells, the tasks, the index and the messages to sessions. */
export const make = Effect.gen(function* () {
  const cells = yield* Cells.Service
  const tasks = yield* Tasks.Service
  const wakes = yield* Wakes.Service
  const index = yield* Index.Service

  /** A decision as a card, as it stands in its cell. */
  const cardOf = Effect.fn("Decisions.cardOf")(function* (id: DecisionId, state: Exclude<DecisionState, { _tag: "Unraised" }>) {
    const task = yield* cells.task(state.task)

    return Card.cases.Decision.make({
      id,
      task: state.task,
      taskTitle: isUnborn(task) ? state.task : task.title,
      session: state.session,
      spec: state.spec,
      ending: isOpen(state) ? null : state.ending,
    })
  })

  /**
   * Tells the coordinator's session how a decision stands, without starting a turn there: the message is for
   * me to read. A coordinator whose session the hub does not know hears nothing.
   */
  const tellCoordinator = Effect.fn("Decisions.tellCoordinator")(function* (card: typeof Card.cases.Decision.Type) {
    const coordinator = seatedSession(yield* cells.coordinator)

    if (coordinator === null) return
    const task = yield* Effect.option(tasks.taskOf(coordinator))

    if (Option.isNone(task)) return yield* Effect.logWarning(`the coordinator ${coordinator} has no task, so it hears nothing of ${card.id}`)

    yield* wakes.send(task.value, {
      id: `${card.id}:${card.ending === null ? "opened" : "closed"}`,
      session: coordinator,
      text: cardText(card),
      card,
      resume: false,
    })
  })

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

  /** Closes a decision, and answers it as a card. */
  const end = Effect.fn("Decisions.end")(function* (id: DecisionId, task: TaskId, ending: Ending) {
    const closed = yield* cells.sendDecision(id, DecisionEvent.Closed({ ending, at: yield* Clock.currentTimeMillis }))
    yield* cells.sendTask(task, TaskEvent.DecisionClosed({ id }))

    if (isUnraised(closed)) return yield* new UnknownDecision({ id })
    const card = yield* cardOf(id, closed)
    yield* tellCoordinator(card)

    return card
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

    const state = yield* cells.sendDecision(id, DecisionEvent.Raised({ spec, task, session, at: yield* Clock.currentTimeMillis }))
    const waits = DecisionKind.guards.Waits(spec.kind)
    yield* cells.sendTask(task, TaskEvent.DecisionOpened({ id, question: spec.question, waits }))

    if (!isUnraised(state)) yield* tellCoordinator(yield* cardOf(id, state))

    return { decision: id, task, meanwhile: meanwhileOf(spec) }
  })

  const answer = Effect.fn("Decisions.answer")(function* (id: DecisionId, given: Answer, note: string, from: AnsweredIn) {
    const decision = yield* openDecision(id)
    yield* known(id, decision.spec, given)
    const card = yield* end(id, decision.task, Ending.cases.Answered.make({ answer: given, note, in: from }))

    if (confirmsDefault(decision.spec, given)) return

    yield* wakes.send(decision.task, { id: `${id}:answer`, session: decision.session, text: answerText(card, given, note) })
  })

  const answerAsCoordinator = Effect.fn("Decisions.answerAsCoordinator")(function* (
    session: SessionId,
    id: DecisionId,
    given: Answer,
    note: string,
  ) {
    if (seatedSession(yield* cells.coordinator) !== session) return yield* new NotCoordinator({ session })

    yield* answer(id, given, note, "coordinator")
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
          Ending.cases.Answered.make({ answer: given, note: reason, in: "session" }),
        )
      },
    })

    yield* end(id, decision.task, ending)
  })

  const inbox = Effect.map(index.inbox, (held) => ({
    waiting: held.waiting.map(cardOfRow),
    questions: held.questions,
    defaulted: held.defaulted.map(cardOfRow),
  })).pipe(Effect.withSpan("Decisions.inbox"))

  const seat = Effect.fn("Decisions.seat")(function* (session: SessionId) {
    yield* cells.seatCoordinator(session)

    return yield* inbox
  })

  return Service.of({ raise, answer, answerAsCoordinator, close, seat, inbox })
})

/** The decisions, still in need of the cells, the tasks, the index and the messages to sessions. */
export const layerWithoutDependencies = Layer.effect(Service, make)
