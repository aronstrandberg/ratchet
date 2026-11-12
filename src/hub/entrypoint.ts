import { WorkerEntrypoint } from "cloudflare:workers"
import { Effect, Schema } from "effect"
import { type Env, mayWake } from "../env.ts"
import { PullRequestFacts, type PullRequestRef } from "../protocol/pull-request.ts"
import { type Binding, SessionFact } from "../protocol/session.ts"
import { runtime } from "./cluster.ts"
import * as Facts from "./facts.ts"
import * as Index from "./index-store.ts"
import * as PullRequests from "./pull-requests.ts"

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

  #mayWake = (session: string): boolean => mayWake(this.env, session)

  #wake = (session: string, text: string) => Effect.tryPromise(() => this.env.GATEWAY.wake(session, text))

  /** Applies an observation of a pull request, then delivers the wake-ups it queued. */
  async pullRequestFacts(facts: unknown): Promise<{ readonly changes: ReadonlyArray<string>; readonly woke: number }> {
    const app = await runtime(this.env)
    const db = this.env.INDEX
    const mayWake = this.#mayWake
    const wake = this.#wake
    return app.runPromise(
      Effect.gen(function* () {
        yield* Index.migrate(db)
        const decoded = yield* Schema.decodeUnknownEffect(PullRequestFacts)(facts)
        const observed = yield* PullRequests.observe(db, decoded, mayWake)
        let woke = 0
        for (const task of observed.queued) woke += yield* PullRequests.deliver(db, task, wake)
        return { changes: observed.changes, woke }
      }).pipe(Effect.withSpan("Hub.pullRequestFacts")),
    )
  }

  /** Tries again to deliver every wake-up that has not reached its session. */
  async deliverWakes(): Promise<number> {
    const app = await runtime(this.env)
    const db = this.env.INDEX
    const wake = this.#wake
    return app.runPromise(
      Effect.gen(function* () {
        yield* Index.migrate(db)
        let woke = 0
        for (const task of yield* Index.tasksWithUndelivered(db)) woke += yield* PullRequests.deliver(db, task, wake)
        return woke
      }),
    )
  }

  /** The pull requests worth reading again: someone follows them and they are not merged or closed. */
  async watchedPullRequests(): Promise<ReadonlyArray<PullRequestRef>> {
    const db = this.env.INDEX
    const rows = await Effect.runPromise(Effect.andThen(Index.migrate(db), Index.pullRequests(db, true)))
    return rows.flatMap((row) => {
      const match = /^([^/]+)\/([^#]+)#(\d+)$/.exec(row.key)
      return match === null ? [] : [{ owner: match[1]!, repo: match[2]!, number: Number(match[3]) }]
    })
  }

  async pullRequests(): Promise<ReadonlyArray<Index.PullRequestRow>> {
    const db = this.env.INDEX
    return Effect.runPromise(Effect.andThen(Index.migrate(db), Index.pullRequests(db, false)))
  }

  async tree(): Promise<ReadonlyArray<Index.TaskNode>> {
    const db = this.env.INDEX
    return Effect.runPromise(Effect.andThen(Index.migrate(db), Index.tree(db)))
  }
}
