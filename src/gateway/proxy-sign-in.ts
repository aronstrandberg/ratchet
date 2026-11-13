import { DurableObject } from "cloudflare:workers"
import { Effect, ManagedRuntime, Redacted, Schema } from "effect"
import type { Env } from "../env.ts"
import { forBinding } from "../failure.ts"
import * as ProxyGrant from "./proxy-grant.ts"

const decode = Schema.decodeUnknownEffect(ProxyGrant.Grant)
const encode = Schema.encodeEffect(ProxyGrant.Grant)

/** Keeps the grant in a Durable Object's own storage, under one key. */
const store = (storage: DurableObjectStorage): ProxyGrant.Store => {
  const failed = (cause: unknown) => new ProxyGrant.GrantFailed({ operation: "store", cause })

  return {
    load: Effect.tryPromise(() => storage.get("grant")).pipe(
      Effect.flatMap((stored) => (stored === undefined ? Effect.succeed(ProxyGrant.empty) : decode(stored))),
      Effect.mapError(failed),
    ),
    save: (grant) =>
      encode(grant).pipe(
        Effect.flatMap((encoded) => Effect.tryPromise(() => storage.put("grant", encoded))),
        Effect.mapError(failed),
      ),
  }
}

/**
 * Holds the gateway's sign-in to the webhook proxy.
 *
 * One object holds it, so two callers never renew the same token at once: a Durable Object handles one call
 * at a time.
 */
export class ProxySignIn extends DurableObject<Env> {
  readonly #grant = ManagedRuntime.make(ProxyGrant.layer(store(this.ctx.storage)))

  #run<A, E>(use: (grant: ProxyGrant.Interface) => Effect.Effect<A, E>): Promise<A> {
    return this.#grant
      .runPromise(Effect.flatMap(ProxyGrant.Service, use))
      .catch((cause: unknown) => Promise.reject(forBinding(cause)))
  }

  /** Starts a sign-in and returns the address to open in a browser. */
  async begin(redirect: string): Promise<string> {
    return this.#run((grant) => grant.begin(redirect))
  }

  /** Finishes a sign-in with the address the browser was sent back to. */
  async complete(callback: string): Promise<void> {
    await this.#run((grant) => grant.complete(new URL(callback)))
  }

  /** A token the proxy accepts. It leaves this object only to be sent to the proxy. */
  async token(): Promise<string> {
    return this.#run((grant) => Effect.map(grant.token, Redacted.value))
  }

  /** Whether a sign-in is in place. */
  async signedIn(): Promise<boolean> {
    return this.#run((grant) => grant.signedIn)
  }
}
