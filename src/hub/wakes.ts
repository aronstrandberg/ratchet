import { Clock, Context, Effect, Layer, Result } from "effect"
import type { Card } from "../protocol/card.ts"
import type { SessionId, TaskId } from "../protocol/ids.ts"
import * as Cells from "./cells.ts"
import * as Index from "./index-store.ts"
import * as SessionControl from "./session-control.ts"
import { TaskEvent, isUnborn } from "./task.ts"
import * as WakePolicy from "./wake-policy.ts"

/** A message for a session, before it is queued. */
export interface Message {
  /**
   * The same for every attempt to send this message. OpenCode admits a message once by its ID, so the same
   * cause gives the same ID.
   */
  readonly id: string
  readonly session: SessionId
  readonly text: string
  /** What the message is about, for a client that draws it as a card. */
  readonly card?: Card
  /** Whether the message starts a turn. It does unless this says otherwise. */
  readonly resume?: boolean
  /**
   * When the message was queued, in milliseconds since the epoch: now unless given. A message sent again
   * after a failure gives the same time, so OpenCode knows it as the same message.
   */
  readonly at?: number
}

type Failure = Cells.CellUnavailable | Index.IndexError

/** Messages Ratchet puts into sessions: queued in the outbox of a task, and kept there until OpenCode has them. */
export interface Interface {
  /**
   * Queues a message on a task and delivers the task's outbox. It answers how many messages reached their
   * session. A session the wake policy leaves out gets no message.
   */
  readonly send: (task: TaskId, message: Message) => Effect.Effect<number, Failure>
  /** Delivers the messages a task holds, and answers how many reached their session. */
  readonly deliver: (task: TaskId) => Effect.Effect<number, Failure>
  /** Tries again to deliver every message that has not reached its session, and answers how many did. */
  readonly deliverPending: Effect.Effect<number, Failure>
  /** Whether the wake policy lets Ratchet put a message into the session. */
  readonly admits: (session: SessionId) => boolean
}

/** The hub's messages to sessions. */
export class Service extends Context.Service<Service, Interface>()("@ratchet/hub/Wakes") {}

/** Builds the messages on the cells, the index, control over sessions and the wake policy. */
export const make = Effect.gen(function* () {
  const cells = yield* Cells.Service
  const index = yield* Index.Service
  const control = yield* SessionControl.Service
  const policy = yield* WakePolicy.Service

  const deliver = Effect.fn("Wakes.deliver")(function* (task: TaskId) {
    const state = yield* cells.task(task)

    if (isUnborn(state)) return 0
    let delivered = 0

    for (const queued of state.outbox) {
      // A message that fails stays queued. It is sent again with the same ID, which OpenCode admits once.
      const sent = yield* Effect.result(control.wake(queued))

      if (Result.isFailure(sent)) continue
      yield* cells.sendTask(task, TaskEvent.WakeDelivered({ id: queued.id }))
      delivered++
    }

    return delivered
  })

  const send = Effect.fn("Wakes.send")(function* (task: TaskId, message: Message) {
    if (!WakePolicy.allows(policy, message.session)) return 0
    const at = message.at ?? (yield* Clock.currentTimeMillis)
    yield* cells.sendTask(
      task,
      TaskEvent.WakeQueued({
        id: message.id,
        session: message.session,
        text: message.text,
        at,
        card: message.card ?? null,
        resume: message.resume ?? true,
      }),
    )

    return yield* deliver(task)
  })

  const deliverPending = Effect.gen(function* () {
    let woke = 0

    for (const task of yield* index.tasksWithUndelivered) woke += yield* deliver(task)

    return woke
  }).pipe(Effect.withSpan("Wakes.deliverPending"))

  return Service.of({ send, deliver, deliverPending, admits: (session) => WakePolicy.allows(policy, session) })
})

/** The messages, still in need of what they are built on. */
export const layerWithoutDependencies = Layer.effect(Service, make)
