import { expect, test } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { SessionId } from "../protocol/ids.ts"
import type { Wake } from "../protocol/wake.ts"
import * as OpenCode from "./opencode.ts"
import * as WakeGate from "./wake-gate.ts"

const session = SessionId.make("ses_1")

const wake = (over: Partial<Wake>): Wake => ({
  id: "o/r#1@aaa:CiFinished",
  session,
  text: "Ratchet: pull request o/r#1 changed.\n- CI passed on aaa.",
  queuedAt: 1,
  card: null,
  resume: true,
  screen: false,
  ...over,
})

/** OpenCode as a test holds it: whether the session runs, what the model answers, and the wake-ups sent. */
const opencode = (running: boolean, answers: ReadonlyMap<string, number> | "fails", sent: Array<Wake>) =>
  Layer.succeed(
    OpenCode.Service,
    OpenCode.Service.of({
      snapshot: Effect.die("unused"),
      facts: Stream.die("unused"),
      session: () => Effect.die("unused"),
      recordTask: () => Effect.die("unused"),
      fork: () => Effect.die("unused"),
      wake: (given) => Effect.sync(() => void sent.push(given)),
      running: () => Effect.succeed(running),
      recent: () => Effect.succeed(["[assistant] Pushed aaa and ended my turn."]),
      judge: () =>
        answers === "fails"
          ? Effect.fail(new OpenCode.OpenCodeUnavailable({ operation: "judge", cause: "down" }))
          : Effect.succeed(answers),
    }),
  )

const config: WakeGate.Config = {
  model: { providerID: "opencode", id: "jev-1.13-free" },
  messages: 14,
  actionable: 0.5,
  known: 0.5,
}

const deliver = (given: Wake, running: boolean, answers: ReadonlyMap<string, number> | "fails") => {
  const sent: Array<Wake> = []

  return Effect.runPromise(
    Effect.flatMap(WakeGate.Service, (gate) => gate.deliver(given)).pipe(
      Effect.provide(WakeGate.layerWithoutDependencies(config).pipe(Layer.provide(opencode(running, answers, sent)))),
      Effect.map((delivery) => [delivery, sent.map((one) => one.resume)] as const),
    ),
  )
}

const newAndActionable = new Map([
  ["known", 0.2],
  ["actionable", 0.8],
])

test("a note and a screened wake-up to a session in a turn wait in its queue, and an act always starts a turn", async () => {
  expect(await deliver(wake({ resume: false }), false, newAndActionable)).toEqual(["queued", [false]])
  expect(await deliver(wake({ screen: true }), true, newAndActionable)).toEqual(["queued", [false]])
  expect(await deliver(wake({}), true, newAndActionable)).toEqual(["turn", [true]])
  expect(await deliver(wake({}), false, newAndActionable)).toEqual(["turn", [true]])
})

test("a screened wake-up starts a turn only when it is new to the session and needs action", async () => {
  const known = new Map([
    ["known", 0.9],
    ["actionable", 0.8],
  ])

  expect(await deliver(wake({ screen: true }), false, newAndActionable)).toEqual(["turn", [true]])
  expect(await deliver(wake({ screen: true }), false, known)).toEqual(["screened-out", [false]])
})

test("a wake-up the model cannot screen starts a turn, so a failure is never missed", async () => {
  expect(await deliver(wake({ screen: true }), false, "fails")).toEqual(["turn", [true]])
  expect(await deliver(wake({ screen: true }), false, new Map())).toEqual(["turn", [true]])
})
