import { WorkerEntrypoint } from "cloudflare:workers"
import { Effect, Result, Schema } from "effect"
import type { Env } from "../env.ts"
import { forBinding } from "../failure.ts"
import { SessionId, TaskId } from "../protocol/ids.ts"
import { ReadReply, ResourceRef } from "../protocol/resource.ts"
import { Wake } from "../protocol/wake.ts"
import type * as Grant from "./grant.ts"
import type * as LiveReads from "./live-reads.ts"
import * as OpenCode from "./opencode.ts"
import * as ResourceReads from "./resource-reads.ts"
import { type Services, runtime } from "./runtime.ts"
import type * as SessionSync from "./session-sync.ts"
import * as SignIns from "./sign-ins.ts"
import * as Systems from "./systems.ts"

const encodeReply = Schema.encodeEffect(ReadReply)

/**
 * The gateway as the hub and the Worker's routes call it.
 *
 * Each method parses what it is given, does one thing outside and answers in plain values. A failure rejects
 * the call with its message, except where the caller acts on which failure it was.
 */
export class Gateway extends WorkerEntrypoint<Env> {
  #run<A, E>(operation: Effect.Effect<A, E, Services>): Promise<A> {
    const gateway = runtime(this.env)

    return Result.isFailure(gateway)
      ? Promise.reject(forBinding(gateway.failure))
      : gateway.success.runPromise(operation).catch((cause: unknown) => Promise.reject(forBinding(cause)))
  }

  /** Makes sure the gateway listens to OpenCode, and reports the connection. */
  async watchOpenCode(): Promise<SessionSync.Status> {
    return this.env.OPENCODE_STREAM.getByName("default").ensure()
  }

  /** Makes sure the gateway listens to the webhook proxy, and reports how the listening is doing. */
  async watchWebhooks(): Promise<LiveReads.Status> {
    return this.env.WEBHOOK_STREAM.getByName("default").ensure()
  }

  /** Where the gateway's sign-in to each system stands. */
  async signIns(): Promise<Readonly<Record<Systems.System, Grant.Status>>> {
    return this.#run(Effect.flatMap(SignIns.Service, (signIns) => signIns.statuses))
  }

  /**
   * Starts a sign-in to a system and returns the address to open in a browser. `origin` is where this Worker
   * is reached, which is where the browser is sent back to.
   */
  async beginSignIn(system: string, origin: string): Promise<string> {
    return this.#run(
      Effect.gen(function* () {
        const signIns = yield* SignIns.Service

        return yield* signIns.begin(yield* Systems.parse(system), origin)
      }),
    )
  }

  /** Finishes a sign-in to a system with the address the browser was sent back to. */
  async completeSignIn(system: string, callback: string): Promise<void> {
    await this.#run(
      Effect.gen(function* () {
        const signIns = yield* SignIns.Service
        yield* signIns.complete(yield* Systems.parse(system), callback)
      }),
    )
  }

  /** Writes a session's current task into the session's metadata. */
  async recordTask(session: typeof SessionId.Encoded, task: typeof TaskId.Encoded): Promise<void> {
    await this.#run(
      Effect.gen(function* () {
        const opencode = yield* OpenCode.Service
        const info = yield* opencode.session(yield* Schema.decodeEffect(SessionId)(session))
        yield* opencode.recordTask(info, yield* Schema.decodeEffect(TaskId)(task))
      }),
    )
  }

  /** Forks a session, names the fork and prompts it. Returns the fork's session ID. */
  async forkSession(session: typeof SessionId.Encoded, title: string, prompt: string): Promise<string> {
    return this.#run(
      Effect.gen(function* () {
        const opencode = yield* OpenCode.Service

        return yield* opencode.fork(yield* Schema.decodeEffect(SessionId)(session), title, prompt)
      }),
    )
  }

  /** Puts a wake-up into its session and lets the session run. Sending the same wake-up again adds nothing. */
  async wake(wake: typeof Wake.Encoded): Promise<void> {
    await this.#run(
      Effect.gen(function* () {
        const opencode = yield* OpenCode.Service
        yield* opencode.wake(yield* Schema.decodeEffect(Wake)(wake))
      }),
    )
  }

  /**
   * Reads a resource from its own system now, and keeps the reading of watched resources going.
   *
   * A resource that is missing or cannot be read is an answer, not a rejection.
   */
  async readResource(ref: typeof ResourceRef.Encoded): Promise<typeof ReadReply.Encoded> {
    await this.env.GITHUB_POLLER.getByName("default").ensure()
    await this.env.WEBHOOK_STREAM.getByName("default").ensure()

    return this.#run(
      Schema.decodeEffect(ResourceRef)(ref).pipe(Effect.flatMap(ResourceReads.read), Effect.flatMap(encodeReply)),
    )
  }
}
