import { DurableObject } from "cloudflare:workers"
import { Effect, ManagedRuntime, Redacted, Schema } from "effect"
import type { Env } from "../env.ts"
import { forBinding } from "../failure.ts"
import * as Grant from "./grant.ts"

const decode = Schema.decodeUnknownEffect(Grant.Grant)
const encode = Schema.encodeEffect(Grant.Grant)
const decodeTarget = Schema.decodeUnknownEffect(Grant.Target)

/** Keeps the grant in a Durable Object's own storage, under one key. */
const store = (storage: DurableObjectStorage): Grant.Store => {
  const failed = (cause: unknown) => new Grant.GrantFailed({ operation: "store", cause })

  return {
    load: Effect.tryPromise(() => storage.get("grant")).pipe(
      Effect.flatMap((stored) => (stored === undefined ? Effect.succeed(Grant.empty) : decode(stored))),
      Effect.mapError(failed),
    ),
    save: (grant) =>
      encode(grant).pipe(
        Effect.flatMap((encoded) => Effect.tryPromise(() => storage.put("grant", encoded))),
        Effect.mapError(failed),
      ),
  }
}

/** What `token` answers. A missing sign-in is an answer, because the caller acts on it. */
export const TokenReply = Schema.TaggedUnion({
  Token: { token: Schema.String },
  NotSignedIn: {},
})

export type TokenReply = typeof TokenReply.Type

/**
 * Holds the gateway's sign-in to one system. The object's name is the system.
 *
 * One object holds it, so two callers never renew the same token at once: a Durable Object handles one call
 * at a time. A system that issues a new refresh token with each renewal honours each one once.
 */
export class SignIn extends DurableObject<Env> {
  readonly #grant = ManagedRuntime.make(Grant.layer(store(this.ctx.storage)))

  #run<A, E>(use: (grant: Grant.Interface) => Effect.Effect<A, E>): Promise<A> {
    return this.#grant
      .runPromise(Effect.flatMap(Grant.Service, use))
      .catch((cause: unknown) => Promise.reject(forBinding(cause)))
  }

  /** Starts a sign-in to a target and returns the address to open in a browser. */
  async begin(target: typeof Grant.Target.Encoded, redirect: string): Promise<string> {
    return this.#run((grant) => Effect.flatMap(decodeTarget(target), (parsed) => grant.begin(parsed, redirect)))
  }

  /** Finishes a sign-in with the address the browser was sent back to. */
  async complete(callback: string): Promise<void> {
    await this.#run((grant) => grant.complete(new URL(callback)))
  }

  /** A token the system accepts. It leaves this object only to be sent to that system. */
  async token(): Promise<typeof TokenReply.Encoded> {
    return this.#run((grant) =>
      grant.token.pipe(
        Effect.map((token) => TokenReply.cases.Token.make({ token: Redacted.value(token) })),
        Effect.catchTag("NotSignedIn", () => Effect.succeed(TokenReply.cases.NotSignedIn.make({}))),
      ),
    )
  }

  /** Marks the access token as used up, after the system refused it. */
  async expire(): Promise<void> {
    await this.#run((grant) => grant.expire)
  }

  /** Where the sign-in stands. */
  async status(): Promise<Grant.Status> {
    return this.#run((grant) => grant.status)
  }
}
