import { Clock, Context, Effect, Layer, Option, Random, Redacted, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"

/** Where the webhook proxy's sign-in lives. Tokens are issued by Lovable's OAuth server for the proxy. */
const oauth = {
  register: "https://lovable.dev/oauth/register",
  authorize: "https://lovable.dev/oauth/authorize",
  token: "https://lovable.dev/oauth/token",
  /** The proxy accepts a token only when it was issued for this resource. */
  resource: "https://lov-webhook-proxy.lovable.app/api/public/mcp",
  scope: "openid offline",
}

/** Nobody has signed in to the webhook proxy yet, or the sign-in was withdrawn. */
export class NotSignedIn extends Schema.TaggedError<NotSignedIn>()("NotSignedIn", {}) {
  /** What a caller on the other side of a binding reads. */
  override get message(): string {
    return "Ratchet is not signed in to the webhook proxy"
  }
}

/** The address given to finish a sign-in does not belong to the sign-in that was started. */
export class UnknownSignIn extends Schema.TaggedError<UnknownSignIn>()("UnknownSignIn", {
  problem: Schema.String,
}) {
  /** What a caller on the other side of a binding reads. */
  override get message(): string {
    return this.problem
  }
}

/** Lovable's OAuth server did not answer, or refused. */
export class GrantFailed extends Schema.TaggedError<GrantFailed>()("GrantFailed", {
  operation: Schema.Literals(["register", "exchange", "refresh", "store"]),
  cause: Schema.Defect(),
}) {
  /** What a caller on the other side of a binding reads. It names the step, and no token. */
  override get message(): string {
    return `the sign-in to the webhook proxy failed at ${this.operation}`
  }
}

const Tokens = Schema.Struct({
  access: Schema.String,
  refresh: Schema.String,
  /** When the access token stops working, in milliseconds since the epoch. */
  expiresAt: Schema.Number,
})

/** What the gateway keeps about its sign-in to the webhook proxy. All of it is secret. */
export const Grant = Schema.Struct({
  /** The OAuth client Ratchet registered for itself, with the address it registered. */
  client: Schema.NullOr(Schema.Struct({ id: Schema.String, redirect: Schema.String })),
  /** A sign-in that was started and not finished. */
  pending: Schema.NullOr(Schema.Struct({ state: Schema.String, verifier: Schema.String })),
  tokens: Schema.NullOr(Tokens),
})

export type Grant = typeof Grant.Type

/** A grant before anyone signed in. */
export const empty: Grant = { client: null, pending: null, tokens: null }

/** Where the grant is kept between calls. */
export interface Store {
  readonly load: Effect.Effect<Grant, GrantFailed>
  readonly save: (grant: Grant) => Effect.Effect<void, GrantFailed>
}

/** The gateway's sign-in to the webhook proxy, as me. */
export interface Interface {
  /**
   * Starts a sign-in and returns the address to open in a browser. `redirect` is where the browser is sent
   * back to: the gateway's own callback route.
   */
  readonly begin: (redirect: string) => Effect.Effect<string, GrantFailed>
  /** Finishes a sign-in with the address the browser was sent back to. */
  readonly complete: (callback: URL) => Effect.Effect<void, UnknownSignIn | GrantFailed>
  /** A token the proxy accepts. It is renewed first when it is about to expire. */
  readonly token: Effect.Effect<Redacted.Redacted<string>, NotSignedIn | GrantFailed>
  /** Whether a sign-in is in place. */
  readonly signedIn: Effect.Effect<boolean, GrantFailed>
}

/** The gateway's grant to read the webhook proxy. */
export class Service extends Context.Service<Service, Interface>()("@ratchet/gateway/ProxyGrant") {}

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "")

/** The PKCE challenge for a verifier: its SHA-256, base64url. */
export const challengeOf = (verifier: string): Effect.Effect<string> =>
  Effect.map(
    Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
    (digest) => base64url(new Uint8Array(digest)),
  )

const randomToken = Effect.map(
  Effect.all(Array.from({ length: 32 }, () => Random.nextIntBetween(0, 255))),
  (bytes) => base64url(Uint8Array.from(bytes)),
)

/** The address that asks me to let Ratchet read the webhook proxy. */
export const authorizeUrl = (request: {
  readonly client: string
  readonly redirect: string
  readonly state: string
  readonly challenge: string
}): string => {
  const url = new URL(oauth.authorize)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("client_id", request.client)
  url.searchParams.set("redirect_uri", request.redirect)
  url.searchParams.set("scope", oauth.scope)
  url.searchParams.set("state", request.state)
  url.searchParams.set("code_challenge", request.challenge)
  url.searchParams.set("code_challenge_method", "S256")
  url.searchParams.set("resource", oauth.resource)

  return url.toString()
}

/** Whether a token should be renewed now: it expires within a minute. */
export const expiresSoon = (tokens: typeof Tokens.Type, now: number): boolean => tokens.expiresAt - now < 60_000

const Registered = Schema.Struct({ client_id: Schema.String })

const Issued = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Number),
})

/** Builds the grant on a store and an HTTP client. Nothing is sent until an operation runs. */
export const make = (store: Store): Effect.Effect<Interface, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const http = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)

    const issue = (operation: "exchange" | "refresh", form: Readonly<Record<string, string>>, keep: string | null) =>
      Effect.gen(function* () {
        const issued = yield* HttpClientRequest.post(oauth.token).pipe(
          HttpClientRequest.bodyUrlParams(form),
          HttpClientRequest.acceptJson,
          http.execute,
          Effect.flatMap(HttpClientResponse.schemaBodyJson(Issued)),
          Effect.mapError((cause) => new GrantFailed({ operation, cause })),
        )

        const refresh = issued.refresh_token ?? keep

        if (refresh === null) {
          return yield* new GrantFailed({ operation, cause: "the server issued no refresh token" })
        }

        const now = yield* Clock.currentTimeMillis

        return { access: issued.access_token, refresh, expiresAt: now + (issued.expires_in ?? 3600) * 1000 }
      })

    const register = Effect.fn("ProxyGrant.register")(function* (redirect: string) {
      const registered = yield* HttpClientRequest.post(oauth.register).pipe(
        HttpClientRequest.bodyJsonUnsafe({
          client_name: "Ratchet",
          redirect_uris: [redirect],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
          scope: oauth.scope,
        }),
        http.execute,
        Effect.flatMap(HttpClientResponse.schemaBodyJson(Registered)),
        Effect.mapError((cause) => new GrantFailed({ operation: "register", cause })),
      )

      return { id: registered.client_id, redirect }
    })

    const begin = Effect.fn("ProxyGrant.begin")(function* (redirect: string) {
      const grant = yield* store.load
      // A client is registered for one address, so another address needs another client.
      const client = grant.client !== null && grant.client.redirect === redirect ? grant.client : yield* register(redirect)
      const state = yield* randomToken
      const verifier = yield* randomToken
      yield* store.save({ ...grant, client, pending: { state, verifier } })

      return authorizeUrl({ client: client.id, redirect, state, challenge: yield* challengeOf(verifier) })
    })

    const complete = Effect.fn("ProxyGrant.complete")(function* (callback: URL) {
      const grant = yield* store.load
      const code = callback.searchParams.get("code")
      const refused = callback.searchParams.get("error")

      if (grant.client === null || grant.pending === null) {
        return yield* new UnknownSignIn({ problem: "no sign-in was started" })
      }

      if (refused !== null) return yield* new UnknownSignIn({ problem: `the sign-in was refused: ${refused}` })

      if (code === null || callback.searchParams.get("state") !== grant.pending.state) {
        return yield* new UnknownSignIn({ problem: "the address does not belong to the sign-in that was started" })
      }

      const tokens = yield* issue(
        "exchange",
        {
          grant_type: "authorization_code",
          code,
          redirect_uri: grant.client.redirect,
          client_id: grant.client.id,
          code_verifier: grant.pending.verifier,
          resource: oauth.resource,
        },
        null,
      )

      yield* store.save({ ...grant, pending: null, tokens })
    })

    const token = Effect.gen(function* () {
      const grant = yield* store.load

      if (grant.client === null || grant.tokens === null) return yield* new NotSignedIn()

      if (!expiresSoon(grant.tokens, yield* Clock.currentTimeMillis)) return Redacted.make(grant.tokens.access)

      const renewed = yield* issue(
        "refresh",
        {
          grant_type: "refresh_token",
          refresh_token: grant.tokens.refresh,
          client_id: grant.client.id,
          resource: oauth.resource,
        },
        grant.tokens.refresh,
      )

      yield* store.save({ ...grant, tokens: renewed })

      return Redacted.make(renewed.access)
    }).pipe(Effect.withSpan("ProxyGrant.token"))

    return Service.of({
      begin,
      complete,
      token,
      signedIn: Effect.map(store.load, (grant) => Option.isSome(Option.fromNullOr(grant.tokens))),
    })
  })

/** The grant on a store, still in need of an HTTP client. */
export const layerWithoutDependencies = (store: Store): Layer.Layer<Service, never, HttpClient.HttpClient> =>
  Layer.effect(Service, make(store))

/** The grant on a store, over `fetch`. */
export const layer = (store: Store): Layer.Layer<Service> =>
  layerWithoutDependencies(store).pipe(Layer.provide(FetchHttpClient.layer))
