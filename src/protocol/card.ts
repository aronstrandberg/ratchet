import { Schema } from "effect"
import { DecisionId, DecisionSpec, Ending } from "./decision.ts"
import { SessionId, TaskId } from "./ids.ts"

/**
 * What a message from Ratchet is about, in a form a client can draw as a card instead of reading the text.
 *
 * OpenCode keeps it in the message's metadata, under `ratchet.card`.
 */
export const Card = Schema.TaggedUnion({
  /** A decision as it stands now: open when `ending` is null. */
  Decision: {
    id: DecisionId,
    task: TaskId,
    taskTitle: Schema.String,
    /** The session that asked, which an answer wakes. */
    session: SessionId,
    spec: DecisionSpec,
    ending: Schema.NullOr(Ending),
  },
})

export type Card = typeof Card.Type
