import { WorkerEntrypoint } from "cloudflare:workers"
import { Effect, Schema } from "effect"
import type { Env } from "../env.ts"
import { SessionFact } from "../protocol/session.ts"
import { runtime } from "./cluster.ts"
import * as Facts from "./facts.ts"
import * as Index from "./index-store.ts"

const decodeFacts = Schema.decodeUnknownEffect(Schema.Array(SessionFact))

/** The hub's interface to the gateway and to the Worker's routes. */
export class Hub extends WorkerEntrypoint<Env> {
  /** Applies facts in order and returns how many it applied. */
  async sessionFacts(facts: ReadonlyArray<unknown>): Promise<number> {
    const app = await runtime(this.env)
    const db = this.env.INDEX
    return app.runPromise(
      Effect.gen(function* () {
        yield* Index.migrate(db)
        const decoded = yield* decodeFacts(facts)
        yield* Effect.forEach(decoded, (fact) => Facts.apply(db, fact), { discard: true })
        return decoded.length
      }),
    )
  }

  async tree(): Promise<ReadonlyArray<Index.TaskNode>> {
    const db = this.env.INDEX
    return Effect.runPromise(Effect.andThen(Index.migrate(db), Index.tree(db)))
  }
}
