import { Effect, Option, Schema } from "effect"

/**
 * The systems the gateway signs in to as me, by the name each sign-in is kept under.
 *
 * GitHub is not one of them: the gateway reads it with a token from its settings.
 */
export const System = Schema.Literals(["webhook-proxy", "linear", "incident-io"])

export type System = typeof System.Type

/** There is no system under this name to sign in to. */
export class UnknownSystem extends Schema.TaggedError<UnknownSystem>()("UnknownSystem", {
  given: Schema.String,
}) {
  /** What a caller on the other side of a binding reads. */
  override get message(): string {
    return `there is no system "${this.given}" to sign in to: the systems are ${System.literals.join(", ")}`
  }
}

const decode = Schema.decodeUnknownOption(System)

/** The system a name in an address stands for. */
export const parse = (given: string): Effect.Effect<System, UnknownSystem> =>
  Option.match(decode(given), {
    onNone: () => Effect.fail(new UnknownSystem({ given })),
    onSome: (system) => Effect.succeed(system),
  })
