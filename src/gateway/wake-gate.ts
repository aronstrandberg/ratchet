import { Context, Effect, Layer, Option } from "effect"
import type { Wake } from "../protocol/wake.ts"
import * as OpenCode from "./opencode.ts"

/** How the gateway delivered a wake-up. */
export type Delivery =
  /** It started a turn. */
  | "turn"
  /** It waits in the session's queue: it was a note, or the session was in a turn already. */
  | "queued"
  /** The classifier found it known to the session or not something to act on, so it waits in the queue. */
  | "screened-out"

/** What the gate is tuned by. */
export interface Config {
  /** The decision model that screens wake-ups. */
  readonly model: OpenCode.ModelRef
  /** How many of the session's latest messages the model reads. */
  readonly messages: number
  /** A wake-up starts a turn when it is at least this likely to need action, */
  readonly actionable: number
  /** and less likely than this to be known to the session already. */
  readonly known: number
}

/** The gateway's delivery of wake-ups: it decides whether one starts a turn, then puts it into its session. */
export interface Interface {
  readonly deliver: (wake: Wake) => Effect.Effect<Delivery, OpenCode.OpenCodeUnavailable>
}

/** The gateway's wake-up gate. */
export class Service extends Context.Service<Service, Interface>()("@ratchet/gateway/WakeGate") {}

const questions = [
  {
    name: "known",
    instructions:
      "Does the session already know everything this notification says, from its own messages and tool results above?",
  },
  {
    name: "actionable",
    instructions:
      "Does this notification require the session to do something it is not already doing, or to tell the user something new?",
  },
]

/** The lines of a wake-up that say what changed, which is what the model judges. */
const changesOf = (wake: Wake) => {
  const lines = wake.text.split("\n").filter((line) => line.startsWith("- "))

  return lines.length === 0 ? wake.text : lines.join("\n")
}

/** Builds the gate on the gateway's connection to OpenCode. */
export const make = (config: Config): Effect.Effect<Interface, never, OpenCode.Service> =>
  Effect.gen(function* () {
    const opencode = yield* OpenCode.Service

    /**
     * Whether a screened wake-up should start a turn. A model that cannot answer lets it start one: a turn
     * too many costs less than a failure nobody hears of.
     */
    const worthATurn = Effect.fn("WakeGate.screen")(function* (wake: Wake) {
      const recent = yield* opencode.recent(wake.session, config.messages)

      const answers = yield* opencode.judge(config.model, [
        `The session's last messages, oldest first:\n${recent.join("\n").slice(-9000)}`,
        `Ratchet would now tell the session:\n${changesOf(wake)}`,
      ], questions)

      const known = Option.fromUndefinedOr(answers.get("known"))
      const actionable = Option.fromUndefinedOr(answers.get("actionable"))

      yield* Effect.annotateCurrentSpan({
        "ratchet.wake.known": Option.getOrElse(known, () => -1),
        "ratchet.wake.actionable": Option.getOrElse(actionable, () => -1),
      })

      if (Option.isNone(known) || Option.isNone(actionable)) return true

      return actionable.value >= config.actionable && known.value < config.known
    })

    const deliver = Effect.fn("WakeGate.deliver")(function* (wake: Wake) {
      const delivery: Delivery = !wake.resume
        ? "queued"
        : !wake.screen
          ? // An act keeps its turn even for a session in one: OpenCode folds it into that turn, and starts
            // one when that turn has ended in the meantime.
            "turn"
          : // A session in a turn reads a screened message at its next step.
            (yield* opencode.running(wake.session))
            ? "queued"
            : (yield* worthATurn(wake).pipe(
                  Effect.catch((failure) => Effect.as(Effect.logWarning("the wake-up was not screened", failure), true)),
                ))
              ? "turn"
              : "screened-out"

      yield* Effect.annotateCurrentSpan({ "ratchet.wake.id": wake.id, "ratchet.wake.delivery": delivery })
      yield* opencode.wake({ ...wake, resume: delivery === "turn" })

      return delivery
    })

    return Service.of({ deliver })
  })

/** The gate, still in need of the connection to OpenCode. */
export const layerWithoutDependencies = (config: Config): Layer.Layer<Service, never, OpenCode.Service> =>
  Layer.effect(Service, make(config))
