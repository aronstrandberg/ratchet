import { Schema } from "effect"
import { Event, Machine, State } from "effect-machine"
import { toEntity } from "effect-machine/cluster"
import { TaskId } from "../protocol/ids.ts"
import { LinearIssueFacts } from "../protocol/linear.ts"
import type { Outcome, Relation } from "../protocol/resource.ts"
import { Subscriber, attachExclusive, detach } from "./subscribers.ts"

const subscribers = { subscribers: Schema.Array(Subscriber) }

/** What the hub holds about a Linear issue: what Linear last said, and who follows it. */
export const LinearIssueState = State({
  Unseen: subscribers,
  Seen: { issue: LinearIssueFacts, ...subscribers },
})

/** A Linear issue's state, in either of its tags. */
export type LinearIssueState = typeof LinearIssueState.Type

/** What can happen to a Linear issue as the hub sees it. */
export const LinearIssueEvent = Event({
  Observed: { facts: LinearIssueFacts },
  Attached: { subscriber: Subscriber },
  Detached: { task: TaskId },
})

const any = [LinearIssueState.Unseen, LinearIssueState.Seen] as const

/**
 * How a Linear issue's state follows from what happens to it.
 *
 * One task at most owns an issue: the issue is that task's ticket. A second task that asks to own it is not
 * added to the subscribers.
 */
export const linearIssueMachine = Machine.make({
  state: LinearIssueState,
  event: LinearIssueEvent,
  initial: LinearIssueState.Unseen({ subscribers: [] }),
})
  .on(any, LinearIssueEvent.Observed, ({ state, event }) =>
    LinearIssueState.Seen({ issue: event.facts, subscribers: state.subscribers }),
  )
  .on(any, LinearIssueEvent.Attached, ({ state, event }) =>
    LinearIssueState.with(state, { subscribers: attachExclusive(state.subscribers, event.subscriber) }),
  )
  .on(any, LinearIssueEvent.Detached, ({ state, event }) =>
    LinearIssueState.with(state, { subscribers: detach(state.subscribers, event.task) }),
  )

/** A Linear issue as a cell: one per issue key. */
export const LinearIssueEntity = toEntity(linearIssueMachine, { type: "LinearIssue" })

/** Something that happened to a Linear issue, in terms a task can act on. */
export const Change = Schema.TaggedUnion({
  /** The issue moved on its team's board, and is not finished. */
  StateChanged: { from: Schema.String, to: Schema.String },
  /** Someone else wrote a comment. */
  Commented: { author: Schema.String },
  /** The issue went to another person, or to nobody. */
  Reassigned: { to: Schema.NullOr(Schema.String) },
  Completed: {},
  Canceled: {},
})

/** One thing that happened to a Linear issue. */
export type Change = typeof Change.Type

const isSeen = LinearIssueState.$is("Seen")

const ended = (facts: LinearIssueFacts): Outcome | null => {
  if (facts.state.type === "completed") return "completed"

  // Linear closes a duplicate the way it closes a canceled issue: nobody will work on it.
  return facts.state.type === "canceled" || facts.state.type === "duplicate" ? "canceled" : null
}

/** How a Linear issue ended, or null while it can still change. */
export const outcomeOf = (state: LinearIssueState): Outcome | null => (isSeen(state) ? ended(state.issue) : null)

/**
 * What changed between two observations of a Linear issue.
 *
 * The first observation of an unfinished issue reports nothing: a task that attaches reads the state itself.
 * My own comments are not changes, because my sessions write under my name.
 */
export const changes = (before: LinearIssueState, after: LinearIssueState): ReadonlyArray<Change> => {
  if (!isSeen(after)) return []
  const outcome = ended(after.issue)

  if (outcome !== null) {
    if (outcomeOf(before) !== null) return []

    return [outcome === "completed" ? Change.cases.Completed.make({}) : Change.cases.Canceled.make({})]
  }

  if (!isSeen(before)) return []
  const found: Array<Change> = []

  if (before.issue.state.name !== after.issue.state.name) {
    found.push(Change.cases.StateChanged.make({ from: before.issue.state.name, to: after.issue.state.name }))
  }

  const seen = new Set(before.issue.comments.map((comment) => comment.id))
  const authors = new Set<string>()

  for (const comment of after.issue.comments) {
    if (!seen.has(comment.id) && comment.author !== after.issue.viewer.name) authors.add(comment.author)
  }

  for (const author of authors) found.push(Change.cases.Commented.make({ author }))

  if (before.issue.assignee?.id !== after.issue.assignee?.id && after.issue.assignee?.id !== after.issue.viewer.id) {
    found.push(Change.cases.Reassigned.make({ to: after.issue.assignee?.name ?? null }))
  }

  return found
}

const isEnd = Change.isAnyOf(["Completed", "Canceled"])
const isBoardMove = Change.isAnyOf(["StateChanged"])

/**
 * Whether a change should wake a session of a task with this relation to the issue.
 *
 * An owner hears a comment, a reassignment away from me and the end. A move on the board is shown and wakes
 * nobody: the owning session makes most of them itself. A task that waits hears only the end.
 */
export const wakes = (relation: Relation, change: Change): boolean => {
  switch (relation) {
    case "context":
      return false
    case "waits_on":
      return isEnd(change)
    case "owns":
      return !isBoardMove(change)
  }
}

/** One line a session can read, for one change. It holds no text written by other people. */
export const describe = (change: Change): string =>
  Change.match(change, {
    StateChanged: ({ from, to }) => `It moved from ${from} to ${to}.`,
    Commented: ({ author }) => `${author} commented.`,
    Reassigned: ({ to }) => (to === null ? "It is no longer assigned to anyone." : `It was assigned to ${to}.`),
    Completed: () => "It was completed.",
    Canceled: () => "It was canceled.",
  })
