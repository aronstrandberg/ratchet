import { WorkerEntrypoint } from "cloudflare:workers"
import { Effect, Schema } from "effect"
import type { Env } from "../env.ts"
import { type Binding, SessionFact } from "../protocol/session.ts"
import { runtime } from "./cluster.ts"
import * as Facts from "./facts.ts"
import * as Index from "./index-store.ts"

const decodeFacts = Schema.decodeUnknownEffect(Schema.Array(SessionFact))

/** The hub's interface to the gateway and to the Worker's routes. */
export class Hub extends WorkerEntrypoint<Env> {
  /** Applies facts in order, and returns the task of each main session the facts opened. */
  async sessionFacts(facts: ReadonlyArray<unknown>): Promise<ReadonlyArray<Binding>> {
    const app = await runtime(this.env)
    const db = this.env.INDEX
    return app.runPromise(
      Effect.gen(function* () {
        yield* Index.migrate(db)
        const decoded = yield* decodeFacts(facts)
        const bindings = yield* Effect.forEach(decoded, (fact) => Facts.apply(db, fact))
        return bindings.filter((binding) => binding !== null)
      }).pipe(Effect.withSpan("Hub.sessionFacts", { attributes: { "ratchet.facts": facts.length } })),
    )
  }

  async tree(): Promise<ReadonlyArray<Index.TaskNode>> {
    const db = this.env.INDEX
    return Effect.runPromise(Effect.andThen(Index.migrate(db), Index.tree(db)))
  }
}
