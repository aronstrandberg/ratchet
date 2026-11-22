import { expect, test } from "bun:test"
import { Cause, Effect, Equal, Exit, Schema, Tracer } from "effect"
import { traceOperation } from "./traced-operation.ts"

class TestFailure extends Schema.TaggedError<TestFailure>()("TestFailure", {
  detail: Schema.String,
}) {}

const options = {
  spanName: "Test.operation",
  operation: "operation",
  errorTagAttribute: "test.error_tag",
  attributes: { "test.operation": "operation" },
}

const causeOf = async <E>(effect: Effect.Effect<unknown, E>) => {
  const exit = await Effect.runPromiseExit(effect)

  if (Exit.isSuccess(exit)) throw new Error("expected the effect to fail")

  return exit.cause
}

const withSpans = async <A, E>(effect: Effect.Effect<A, E>) => {
  const spans: Array<Tracer.NativeSpan> = []

  const tracer = Tracer.make({
    span: (spanOptions) => {
      const span = new Tracer.NativeSpan(spanOptions)
      spans.push(span)

      return span
    },
  })

  const exit = await Effect.runPromiseExit(Effect.provideService(effect, Tracer.Tracer, tracer))

  return { exit, spans }
}

test("traceOperation preserves a typed failure cause", async () => {
  const effect = Effect.fail(new TestFailure({ detail: "typed-secret" }))

  const direct = await causeOf(effect)
  const traced = await causeOf(traceOperation(effect, options))

  expect(Equal.equals(traced, direct)).toBe(true)
})

test("traceOperation preserves a defect cause", async () => {
  const effect = Effect.die(new Error("defect-secret"))

  const direct = await causeOf(effect)
  const traced = await causeOf(traceOperation(effect, options))

  expect(Equal.equals(traced, direct)).toBe(true)
})

test("traceOperation preserves an interruption cause", async () => {
  const effect = Effect.failCause(Cause.interrupt(123))

  const direct = await causeOf(effect)
  const traced = await causeOf(traceOperation(effect, options))

  expect(Equal.equals(traced, direct)).toBe(true)
})

test("traceOperation preserves a composite cause", async () => {
  const failure = new TestFailure({ detail: "composite-typed-secret" })

  const cause = Cause.combine(
    Cause.fail(failure),
    Cause.combine(Cause.die(new Error("composite-defect-secret")), Cause.interrupt(456)),
  )

  const effect = Effect.failCause(cause)

  const direct = await causeOf(effect)
  const traced = await causeOf(traceOperation(effect, options))

  expect(Equal.equals(traced, direct)).toBe(true)
})

test("traceOperation ends a typed failure span as failed without its secret", async () => {
  const effect = Effect.fail(new TestFailure({ detail: "span-secret" }))

  const { spans } = await withSpans(traceOperation(effect, options))
  const span = spans.find(({ name }) => name === options.spanName)

  expect(span?.status._tag).toBe("Ended")

  if (span?.status._tag !== "Ended") throw new Error("expected the operation span to end")

  expect(Exit.isFailure(span.status.exit)).toBe(true)
  expect(Cause.pretty(Exit.isFailure(span.status.exit) ? span.status.exit.cause : Cause.empty)).not.toContain(
    "span-secret",
  )
  expect(Object.fromEntries(span.attributes)).toMatchObject({
    "test.operation": "operation",
    "test.error_tag": "TestFailure",
  })
})

test("traceOperation ends a defect span as failed without its message", async () => {
  const { spans } = await withSpans(traceOperation(Effect.die(new Error("defect-span-secret")), options))
  const span = spans.find(({ name }) => name === options.spanName)

  expect(span?.status._tag).toBe("Ended")

  if (span?.status._tag !== "Ended") throw new Error("expected the operation span to end")

  if (Exit.isSuccess(span.status.exit)) throw new Error("expected the operation span to fail")

  expect(Cause.hasDies(span.status.exit.cause)).toBe(true)
  expect(Cause.pretty(span.status.exit.cause)).not.toContain("defect-span-secret")
  expect(span.attributes.get("test.error_tag")).toBe("Error")
})

test("traceOperation ends an interrupted span with an interruption cause", async () => {
  const { spans } = await withSpans(traceOperation(Effect.failCause(Cause.interrupt(789)), options))
  const span = spans.find(({ name }) => name === options.spanName)

  expect(span?.status._tag).toBe("Ended")

  if (span?.status._tag !== "Ended") throw new Error("expected the operation span to end")

  if (Exit.isSuccess(span.status.exit)) throw new Error("expected the operation span to fail")

  expect(Cause.hasInterrupts(span.status.exit.cause)).toBe(true)
  expect(span.attributes.get("test.error_tag")).toBe("Interrupted")
})

test("traceOperation returns a successful value and ends its span successfully", async () => {
  const { exit, spans } = await withSpans(traceOperation(Effect.succeed(42), options))
  const span = spans.find(({ name }) => name === options.spanName)

  expect(exit).toEqual(Exit.succeed(42))
  expect(span?.status._tag).toBe("Ended")

  if (span?.status._tag !== "Ended") throw new Error("expected the operation span to end")

  expect(Exit.isSuccess(span.status.exit)).toBe(true)
})
