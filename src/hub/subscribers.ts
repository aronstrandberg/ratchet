import { Schema } from "effect"
import { SessionId, TaskId } from "../protocol/ids.ts"
import { Relation } from "../protocol/resource.ts"

/** A task that follows a resource, and the session of it that attached. */
export const Subscriber = Schema.Struct({ task: TaskId, session: SessionId, relation: Relation })

export type Subscriber = typeof Subscriber.Type

/** The subscribers after a task attaches. A task that attaches again replaces its earlier entry. */
export const attach = (subscribers: ReadonlyArray<Subscriber>, subscriber: Subscriber): ReadonlyArray<Subscriber> => [
  ...subscribers.filter((held) => held.task !== subscriber.task),
  subscriber,
]

/**
 * The subscribers after a task attaches to a resource that one task at most may own.
 *
 * A second task that asks to own it is not added, so the caller sees itself missing and knows it was refused.
 */
export const attachExclusive = (
  subscribers: ReadonlyArray<Subscriber>,
  subscriber: Subscriber,
): ReadonlyArray<Subscriber> =>
  subscriber.relation === "owns" && subscribers.some((held) => held.relation === "owns" && held.task !== subscriber.task)
    ? subscribers
    : attach(subscribers, subscriber)

/** The subscribers after a task detaches. */
export const detach = (subscribers: ReadonlyArray<Subscriber>, task: TaskId): ReadonlyArray<Subscriber> =>
  subscribers.filter((held) => held.task !== task)
