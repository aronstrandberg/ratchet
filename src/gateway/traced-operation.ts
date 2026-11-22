import { Cause, Effect, Exit, Option, Ref, Schema, type Tracer } from "effect"

class TracedOperationFailure extends Schema.TaggedError<TracedOperationFailure>()("TracedOperationFailure", {
  operation: Schema.String,
  errorTag: Schema.String,
}) {}

class TracedOperationDefect extends Schema.TaggedError<TracedOperationDefect>()("TracedOperationDefect", {
  operation: Schema.String,
  defectTag: Schema.String,
}) {}

const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/
const Identifier = Schema.String.pipe(Schema.check(Schema.isPattern(identifier)))

const decodeDefectIdentity = Schema.decodeUnknownOption(
  Schema.Struct({
    _tag: Schema.optional(Identifier),
    name: Schema.optional(Identifier),
  }),
)

const defectTagOf = (reason: Cause.Die): string =>
  Option.match(decodeDefectIdentity(reason.defect), {
    onNone: () => "Defect",
    onSome: ({ _tag, name }) => _tag ?? name ?? "Defect",
  })

const errorTagOf = <E extends { readonly _tag: string }>(cause: Cause.Cause<E>): string => {
  const reason = cause.reasons[0]

  if (reason === undefined) return "Unknown"

  if (Cause.isFailReason(reason)) return reason.error._tag

  if (Cause.isDieReason(reason)) return defectTagOf(reason)

  return "Interrupted"
}

const sanitizedCause = <E extends { readonly _tag: string }>(
  cause: Cause.Cause<E>,
  operation: string,
): Cause.Cause<TracedOperationFailure> =>
  Cause.fromReasons(
    cause.reasons.map((reason): Cause.Reason<TracedOperationFailure> => {
      if (Cause.isFailReason(reason)) {
        return Cause.makeFailReason(new TracedOperationFailure({ operation, errorTag: reason.error._tag }))
      }

      if (Cause.isDieReason(reason)) {
        return Cause.makeDieReason(new TracedOperationDefect({ operation, defectTag: defectTagOf(reason) }))
      }

      return Cause.makeInterruptReason(reason.fiberId)
    }),
  )

/** Runs one gateway adapter operation under a span without exposing its failure values. */
export const traceOperation = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
  options: {
    readonly spanName: string
    readonly operation: string
    readonly errorTagAttribute: string
    readonly attributes: NonNullable<Tracer.SpanOptions["attributes"]>
  },
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const completed = yield* Ref.make(Option.none<Exit.Exit<A, E>>())

    yield* Effect.exit(effect).pipe(
      Effect.flatMap((exit) =>
        Ref.set(completed, Option.some(exit)).pipe(
          Effect.andThen(
            Exit.match(exit, {
              onFailure: (cause) =>
                Effect.annotateCurrentSpan(options.errorTagAttribute, errorTagOf(cause)).pipe(
                  Effect.andThen(Effect.failCause(sanitizedCause(cause, options.operation))),
                ),
              onSuccess: () => Effect.void,
            }),
          ),
        ),
      ),
      Effect.withSpan(options.spanName, { attributes: { ...options.attributes } }),
      Effect.exit,
    )

    const exit = yield* Ref.get(completed)

    if (Option.isNone(exit)) return yield* Effect.die(`${options.spanName} did not complete`)

    return yield* Exit.match(exit.value, { onFailure: Effect.failCause, onSuccess: Effect.succeed })
  })
