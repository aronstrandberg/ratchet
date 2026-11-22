import { Effect, Schema } from "effect"
import { Card } from "./card.ts"
import { SessionId } from "./ids.ts"

/** A message Ratchet has queued for a session, until OpenCode has admitted it. */
export const Wake = Schema.Struct({
  /** The same for every attempt to deliver this message. */
  id: Schema.String,
  session: SessionId,
  text: Schema.String,
  /** When it was queued, in milliseconds since the epoch. */
  queuedAt: Schema.Number.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
  /** What the message is about, for a client that draws it as a card. */
  card: Schema.NullOr(Card).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  /**
   * Whether the message starts a turn. A notice that only keeps the reader informed does not: the session's
   * agent reads it with the next message.
   */
  resume: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
})

export type Wake = typeof Wake.Type
