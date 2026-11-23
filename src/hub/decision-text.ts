import type { Card } from "../protocol/card.ts"
import { Answer, DecisionKind, type DecisionSpec, Ending } from "../protocol/decision.ts"

type DecisionCard = typeof Card.cases.Decision.Type

/** What the session that raised a decision does until it has an answer. */
export const meanwhileOf = (spec: DecisionSpec): string =>
  DecisionKind.match(spec.kind, {
    Reversible: () =>
      `Act on "${spec.recommended}" now. If the user chooses another option, Ratchet messages this session, and you undo it as you said.`,
    Waits: () =>
      "Do nothing that depends on this choice until Ratchet messages this session with the answer. Work on something else, or end your turn.",
  })

const givenText = (answer: Answer) =>
  Answer.match(answer, {
    Chose: ({ option }) => `chose "${option}"`,
    Wrote: ({ text }) => `answered in their own words: ${text}`,
  })

/** The message that brings my answer to the session that asked. */
export const answerText = (card: DecisionCard, answer: Answer, note: string): string => {
  const next = DecisionKind.match(card.spec.kind, {
    Reversible: ({ undo }) =>
      `You acted on "${card.spec.recommended}" meanwhile. Undo that as you said (${undo}), then act on this answer.`,
    Waits: ({ blocks }) => `Go on with what waited on this answer: ${blocks}`,
  })

  return [
    `Ratchet: the user answered your decision "${card.spec.question}" (${card.id}).`,
    `- The user ${givenText(answer)}.`,
    ...(note === "" ? [] : [`- Their note: ${note}`]),
    next,
    `It belongs to your task "${card.taskTitle}".`,
  ].join("\n")
}

/**
 * A decision as the coordinator's session reads it, in Markdown: the brief first, then the options. A
 * client that draws the message's card shows that instead.
 */
export const cardText = (card: DecisionCard): string => {
  const heading = `**Decision ${card.id}** from task "${card.taskTitle}" (${card.session})`

  if (card.ending !== null) {
    const how = Ending.match(card.ending, {
      Answered: ({ answer, note, in: where }) =>
        `The user ${givenText(answer)}, in the ${where}${note === "" ? "" : `. Note: ${note}`}.`,
      Superseded: ({ by }) => `It was replaced by ${by}.`,
      Withdrawn: ({ reason }) => `The session withdrew it: ${reason}`,
    })

    return [heading, `Closed: "${card.spec.question}". ${how}`].join("\n\n")
  }

  const options = card.spec.options.map(
    (option, at) =>
      `${at + 1}. **${option.label}**${option.label === card.spec.recommended ? " (recommended)" : ""}: ${option.effect}`,
  )

  const stance = DecisionKind.match(card.spec.kind, {
    Reversible: ({ undo }) => `The session acts on the recommended option meanwhile. Undone by: ${undo}`,
    Waits: ({ blocks }) => `The session waits for the answer. It holds up: ${blocks}`,
  })

  return [
    heading,
    `### ${card.spec.question}`,
    card.spec.brief,
    options.join("\n"),
    `Recommended because: ${card.spec.reason}`,
    stance,
  ].join("\n\n")
}
