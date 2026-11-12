import { Effect, Schema } from "effect"

/** A message Ratchet has queued for a session, until OpenCode has admitted it. */
export const Wake = Schema.Struct({
  /** The same for every attempt to deliver this message. */
  id: Schema.String,
  session: Schema.String,
  text: Schema.String,
  /** When it was queued, in milliseconds since the epoch. */
  queuedAt: Schema.Number.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
})

export type Wake = typeof Wake.Type
