import { WorkerEntrypoint } from "cloudflare:workers"
import { Effect, Schema } from "effect"
import type { Env } from "../env.ts"
import { forBinding } from "../failure.ts"
import { ResourceFacts, ResourceRef } from "../protocol/resource.ts"
import { Binding, SessionFact } from "../protocol/session.ts"
import { type Services, runtime } from "./cluster.ts"
import * as Index from "./index-store.ts"
import * as Resources from "./resources.ts"
import * as Tasks from "./tasks.ts"

const decodeFacts = Schema.decodeEffect(Schema.Array(SessionFact))
const encodeBindings = Schema.encodeEffect(Schema.Array(Binding))
const decodeObservation = Schema.decodeEffect(ResourceFacts)
const encodeRefs = Schema.encodeEffect(Schema.Array(ResourceRef))

/**
 * The hub as the gateway and the Worker's routes call it.
 *
 * Each method parses what it is given, runs one operation of the hub and answers in plain values. A failure
 * rejects the call with its message.
 */
export class Hub extends WorkerEntrypoint<Env> {
  #run<A, E>(operation: Effect.Effect<A, E, Services>): Promise<A> {
    return runtime(this.env)
      .then((hub) => hub.runPromise(operation))
      .catch((cause: unknown) => Promise.reject(forBinding(cause)))
  }

  /** Applies facts about sessions in order, and returns the task of each main session the facts opened. */
  async sessionFacts(
    facts: ReadonlyArray<typeof SessionFact.Encoded>,
  ): Promise<ReadonlyArray<typeof Binding.Encoded>> {
    return this.#run(
      Effect.gen(function* () {
        const tasks = yield* Tasks.Service

        return yield* encodeBindings(yield* tasks.observe(yield* decodeFacts(facts)))
      }).pipe(Effect.withSpan("Hub.sessionFacts", { attributes: { "ratchet.facts": facts.length } })),
    )
  }

  /** Applies an observation of a resource and delivers the wake-ups it leads to. */
  async resourceFacts(observed: typeof ResourceFacts.Encoded): Promise<Resources.Observed> {
    return this.#run(
      Effect.gen(function* () {
        const resources = yield* Resources.Service

        return yield* resources.observe(yield* decodeObservation(observed))
      }).pipe(Effect.withSpan("Hub.resourceFacts")),
    )
  }

  /** Tries again to deliver every wake-up that has not reached its session. */
  async deliverWakes(): Promise<number> {
    return this.#run(Effect.flatMap(Resources.Service, (resources) => resources.deliverPending))
  }

  /** The resources worth reading again: someone follows them and they have not ended. */
  async watchedResources(): Promise<ReadonlyArray<typeof ResourceRef.Encoded>> {
    return this.#run(Effect.flatMap(Effect.flatMap(Resources.Service, (resources) => resources.watched), encodeRefs))
  }

  /** Every resource the hub knows, the latest change first. */
  async resources(): Promise<ReadonlyArray<Index.ResourceRow>> {
    return this.#run(Effect.flatMap(Index.Service, (index) => index.resources("all")))
  }

  /** Every task as a forest. */
  async tree(): Promise<ReadonlyArray<Index.TaskNode>> {
    return this.#run(Effect.flatMap(Index.Service, (index) => index.tree))
  }
}
