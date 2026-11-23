import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { Card } from "../protocol/card.ts"
import { Answer, AnsweredIn, DecisionId, DecisionKind, DecisionSpec, Ending, confirmsDefault, problemOf } from "../protocol/decision.ts"
import { SessionId, type TaskId } from "../protocol/ids.ts"
import type { Wake } from "../protocol/wake.ts"
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

/** The coordinator tried to answer a decision its own session raised. */
export class OwnDecision extends Schema.TaggedError<OwnDecision>()("OwnDecision", { id: DecisionId }) {
  override get message(): string {
    return `decision ${this.id} was raised by this session, so the user answers it`
  }
}

/** Another session holds the coordinator's seat, and the call did not say to take it over. */
export class SeatTaken extends Schema.TaggedError<SeatTaken>()("SeatTaken", { session: SessionId }) {
  override get message(): string {
    return `session ${this.session} is the coordinator already`
  }
}

/** A decision a session raised, and what the session is to do now. */
export const Raised = Schema.Struct({
  decision: DecisionId,
  task: Schema.String,
  /** What the session does until an answer arrives. */
  meanwhile: Schema.String,
  /** Whether Ratchet will message the session with the answer. */
  wakes: Schema.Boolean,
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
  ) => Effect.Effect<void, NotCoordinator | OwnDecision | UnknownDecision | DecisionClosed | UnknownOption | Failure>
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
  /**
   * Makes a session the coordinator, which Ratchet tells about every decision from now on. A seat another
   * session holds is taken over only with `replace`.
   */
  readonly seat: (session: SessionId, replace: boolean) => Effect.Effect<InboxCards, SeatTaken | Failure>
  readonly inbox: Effect.Effect<InboxCards, Index.IndexError>
}

/** The hub's decisions. */
export class Service extends Context.Service<Service, Interface>()("@ratchet/hub/Decisions") {}

type RaisedState = Exclude<DecisionState, { readonly _tag: "Unraised" }>

type Closed = Extract<DecisionState, { readonly _tag: "Closed" }>

const encodeEnding = (ending: Ending) => JSON.stringify(Schema.encodeSync(Ending)(ending))

const encodeSpec = Schema.encodeSync(DecisionSpec)

/**
 * A decision's ID: `dec_` and 24 hex digits of a hash of the session, its task, the spec and what it
 * supersedes. A raise sent again after a failure names the same decision, so it does not raise a second one.
 */
const decisionIdOf = (session: SessionId, task: TaskId, spec: DecisionSpec, supersedes: Option.Option<DecisionId>) =>
  Effect.promise(() =>
    crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify([session, task, encodeSpec(spec), Option.getOrNull(supersedes)])),
    ),
  ).pipe(
    Effect.map((digest) =>
      DecisionId.make(`dec_${[...new Uint8Array(digest).slice(0, 12)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`),
    ),
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
  const cardOf = Effect.fn("Decisions.cardOf")(function* (id: DecisionId, state: RaisedState) {
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
   * me to read. The notice is a convenience, so a notice that fails is logged and the decision goes on.
   */
  const tellCoordinator = (card: typeof Card.cases.Decision.Type, at: number) =>
    Effect.gen(function* () {
      const coordinator = seatedSession(yield* cells.coordinator)

      if (coordinator === null) return
      const task = yield* tasks.taskOf(coordinator)

      yield* wakes.send(task, {
        id: `${card.id}:${card.ending === null ? "opened" : "closed"}`,
        session: coordinator,
        text: cardText(card),
        card,
        resume: false,
        at,
      })
    }).pipe(
      Effect.catch((failure) => Effect.logWarning(`the coordinator did not hear of ${card.id}`, failure)),
      Effect.withSpan("Decisions.tellCoordinator"),
    )

  /** The message that brings an answer to the session that asked, or null when it needs none. */
  const answerWake = (card: typeof Card.cases.Decision.Type, closed: Closed): Wake | null => {
    const ending = closed.ending

    if (!Ending.guards.Answered(ending) || ending.in === "session") return null

    if (confirmsDefault(closed.spec, ending.answer) || !wakes.admits(closed.session)) return null

    return {
      id: `${card.id}:answer`,
      session: closed.session,
      text: answerText(card, ending.answer, ending.note),
      // The time the decision closed, so the message is the same however often this runs.
      queuedAt: closed.closedAt,
      card: null,
      resume: true,
      screen: false,
    }
  }

  /**
   * Does what follows a decision's close: the task lets it go and queues the answer for the session that
   * asked, in one step, and the coordinator hears of it. Each step can run again without effect, so a close
   * that failed half way is finished by the next call that finds the decision closed.
   */
  const settle = Effect.fn("Decisions.settle")(function* (id: DecisionId, closed: Closed) {
    const card = yield* cardOf(id, closed)
    yield* cells.sendTask(closed.task, TaskEvent.DecisionClosed({ id, wake: answerWake(card, closed) }))
    yield* wakes.deliver(closed.task)
    yield* tellCoordinator(card, closed.closedAt)
  })

  /** An open decision, or why it cannot be acted on. A closed one whose close did not finish is finished. */
  const openDecision = Effect.fn("Decisions.open")(function* (id: DecisionId) {
    const state: DecisionState = yield* cells.decision(id)

    if (isUnraised(state)) return yield* new UnknownDecision({ id })

    if (isOpen(state)) return state
    const task = yield* cells.task(state.task)

    if (!isUnborn(task) && task.decisions.some((decision) => decision.id === id)) yield* settle(id, state)

    return yield* new DecisionClosed({ id, ending: state.ending })
  })

  const ofSession = Effect.fn("Decisions.ofSession")(function* (session: SessionId, id: DecisionId) {
    const decision = yield* openDecision(id)

    if (!(yield* tasks.tasksOf(session)).includes(decision.task)) return yield* new NotADecisionOfSession({ id })

    return decision
  })

  /**
   * Closes a decision. Of two calls that close it differently at once, the cell keeps the first, and the
   * second learns that it lost. A call that closes it the same way again finishes what the first left undone.
   */
  const end = Effect.fn("Decisions.end")(function* (id: DecisionId, ending: Ending) {
    const closed = yield* cells.sendDecision(id, DecisionEvent.Closed({ ending, at: yield* Clock.currentTimeMillis }))

    if (isUnraised(closed) || isOpen(closed)) return yield* new UnknownDecision({ id })

    if (encodeEnding(closed.ending) !== encodeEnding(ending)) {
      return yield* new DecisionClosed({ id, ending: closed.ending })
    }

    yield* settle(id, closed)
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

    if (Option.isSome(supersedes)) {
      const old = yield* ofSession(session, supersedes.value)

      if (old.task !== task) return yield* new NotADecisionOfSession({ id: supersedes.value })
    }

    const id = yield* decisionIdOf(session, task, spec, supersedes)
    const at = yield* Clock.currentTimeMillis
    const state = yield* cells.sendDecision(id, DecisionEvent.Raised({ spec, task, session, at }))

    if (isUnraised(state)) return yield* new UnknownDecision({ id })

    if (!isOpen(state)) {
      return yield* new InvalidDecision({
        problem: `it repeats decision ${id} word for word, which has closed (${state.ending._tag}). To ask again, change the brief to say what changed since`,
      })
    }

    // A raise sent again after a failure finds the same decision, and each step below changes nothing twice.
    yield* cells.sendTask(task, TaskEvent.DecisionOpened({ id, question: spec.question, waits: DecisionKind.guards.Waits(spec.kind) }))

    // The new decision exists before the old one names it.
    if (Option.isSome(supersedes)) {
      yield* end(supersedes.value, Ending.cases.Superseded.make({ by: id })).pipe(
        Effect.catchTag("DecisionClosed", () => Effect.void),
      )
    }

    yield* tellCoordinator(yield* cardOf(id, state), state.raisedAt)

    return { decision: id, task, meanwhile: meanwhileOf(spec), wakes: wakes.admits(session) }
  })

  const answer = Effect.fn("Decisions.answer")(function* (id: DecisionId, given: Answer, note: string, from: AnsweredIn) {
    const decision = yield* openDecision(id)
    yield* known(id, decision.spec, given)
    yield* end(id, Ending.cases.Answered.make({ answer: given, note, in: from }))
  })

  const answerAsCoordinator = Effect.fn("Decisions.answerAsCoordinator")(function* (
    session: SessionId,
    id: DecisionId,
    given: Answer,
    note: string,
  ) {
    if (seatedSession(yield* cells.coordinator) !== session) return yield* new NotCoordinator({ session })
    const decision = yield* openDecision(id)

    if (decision.session === session) return yield* new OwnDecision({ id })

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

    yield* end(id, ending)
  })

  const inbox = Effect.map(index.inbox, (held) => ({
    waiting: held.waiting.map(cardOfRow),
    questions: held.questions,
    defaulted: held.defaulted.map(cardOfRow),
  })).pipe(Effect.withSpan("Decisions.inbox"))

  const seat = Effect.fn("Decisions.seat")(function* (session: SessionId, replace: boolean) {
    const held = seatedSession(yield* cells.coordinator)

    if (held !== null && held !== session && !replace) return yield* new SeatTaken({ session: held })
    yield* cells.seatCoordinator(session)

    return yield* inbox
  })

  return Service.of({ raise, answer, answerAsCoordinator, close, seat, inbox })
})

/** The decisions, still in need of the cells, the tasks, the index and the messages to sessions. */
export const layerWithoutDependencies = Layer.effect(Service, make)
