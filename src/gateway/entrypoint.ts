import { WorkerEntrypoint } from "cloudflare:workers"
import { Effect, Result, Schema } from "effect"
import type { Env } from "../env.ts"
import { SessionId, TaskId } from "../protocol/ids.ts"
import { PullRequestRef, ReadReply } from "../protocol/pull-request.ts"
import { Wake } from "../protocol/wake.ts"
import * as GitHub from "./github.ts"
import * as OpenCode from "./opencode.ts"
import { type Services, runtime } from "./runtime.ts"
import type * as SessionSync from "./session-sync.ts"

const encodeReply = Schema.encodeEffect(ReadReply)
const Reply = ReadReply.cases

/**
 * The gateway as the hub and the Worker's routes call it.
 *
 * Each method parses what it is given, does one thing outside and answers in plain values. A failure rejects
 * the call with its message, except where the caller acts on which failure it was.
 */
export class Gateway extends WorkerEntrypoint<Env> {
  #run<A, E>(operation: Effect.Effect<A, E, Services>): Promise<A> {
    const gateway = runtime(this.env)

    return Result.isFailure(gateway) ? Promise.reject(gateway.failure) : gateway.success.runPromise(operation)
  }

  /** Makes sure the gateway listens to OpenCode, and reports the connection. */
  async watchOpenCode(): Promise<SessionSync.Status> {
    return this.env.OPENCODE_STREAM.getByName("default").ensure()
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
   * Reads a pull request from GitHub now, and keeps the reading of watched pull requests going.
   *
   * A pull request that is missing or cannot be read is an answer, not a rejection.
   */
  async readPullRequest(ref: typeof PullRequestRef.Encoded): Promise<typeof ReadReply.Encoded> {
    await this.env.GITHUB_POLLER.getByName("default").ensure()

    return this.#run(
      Effect.gen(function* () {
        const github = yield* GitHub.Service
        const pullRequest = yield* Schema.decodeEffect(PullRequestRef)(ref)

        const reply = yield* github.read(pullRequest).pipe(
          Effect.map((facts) => Reply.Read.make({ facts })),
          Effect.catchTags({
            PullRequestNotFound: () => Effect.succeed(Reply.NotFound.make({})),
            GitHubUnavailable: (failure) => Effect.succeed(Reply.Unavailable.make({ message: String(failure.cause) })),
          }),
        )

        return yield* encodeReply(reply)
      }),
    )
  }
}
