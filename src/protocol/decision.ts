import { Schema } from "effect"

/** Identifies a decision. A decision ID starts with `dec_`. */
export const DecisionId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^dec_[0-9a-f]+$/)),
  Schema.brand("DecisionId"),
)

export type DecisionId = typeof DecisionId.Type

const text = (most: number) => Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(most)))

/** One way a decision can go. */
export const Choice = Schema.Struct({
  /** What the option is called. It names the option when the session recommends it and when I choose it. */
  label: text(80),
  /** What changes if it is chosen, what it costs and what can go wrong. */
  effect: text(400),
})

export type Choice = typeof Choice.Type

/** Whether the session may act on the recommended option before I answer. */
export const DecisionKind = Schema.TaggedUnion({
  /** The session acts on the recommended option at once. `undo` says how that is undone if I choose another. */
  Reversible: { undo: text(300) },
  /** The session does nothing that depends on the choice until I answer. `blocks` says what that holds up. */
  Waits: { blocks: text(300) },
})

export type DecisionKind = typeof DecisionKind.Type

/** A decision as a session raises it. */
export const DecisionSpec = Schema.Struct({
  question: text(140),
  /** The current state, and why the choice is mine and not the session's. */
  context: text(600),
  options: Schema.Array(Choice).pipe(Schema.check(Schema.isMinLength(2), Schema.isMaxLength(4))),
  /** The label of the option the session recommends. */
  recommended: Schema.String,
  /** Why the session recommends it. */
  reason: text(400),
  kind: DecisionKind,
})

export type DecisionSpec = typeof DecisionSpec.Type

/** What I answered. */
export const Answer = Schema.TaggedUnion({
  /** One of the options, by its label. */
  Chose: { option: Schema.String },
  /** An answer in my own words, when no option fits. */
  Wrote: { text: text(2000) },
})

export type Answer = typeof Answer.Type

/** Where an answer was given: in Ratchet's inbox, or in the session's own window, as the session reports it. */
export const AnsweredIn = Schema.Literals(["inbox", "session"])

export type AnsweredIn = typeof AnsweredIn.Type

/** How a decision ended. */
export const Ending = Schema.TaggedUnion({
  Answered: { answer: Answer, note: Schema.String, in: AnsweredIn },
  /** A newer decision of the same task replaced it. */
  Superseded: { by: DecisionId },
  /** The session said the question no longer matters. */
  Withdrawn: { reason: Schema.String },
})

export type Ending = typeof Ending.Type

/** Why a spec cannot be raised as it is, or null when it can. The schema checks lengths, this the rest. */
export const problemOf = (spec: DecisionSpec): string | null => {
  const labels = spec.options.map((option) => option.label)

  if (new Set(labels).size !== labels.length) return "two options have the same label"

  if (!labels.includes(spec.recommended)) {
    return `the recommended option "${spec.recommended}" is not one of the options: ${labels.map((label) => `"${label}"`).join(", ")}`
  }

  return null
}

/** Whether an answer says to do what the session already acts on: the recommended option of a reversible decision. */
export const confirmsDefault = (spec: DecisionSpec, answer: Answer): boolean =>
  DecisionKind.guards.Reversible(spec.kind) && Answer.guards.Chose(answer) && answer.option === spec.recommended
