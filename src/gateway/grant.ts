import { Clock, Context, Effect, Layer, Random, Redacted, Result, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"

/** What the gateway signs in to: an address a system serves, and what to ask it for. */
export const Target = Schema.Struct({
  /** The address the system protects, such as its MCP endpoint. Its tokens are issued for this address. */
  resource: Schema.String,
  /** The scope to ask for, or null to let the system choose. */
  scope: Schema.NullOr(Schema.String),
})

export type Target = typeof Target.Type

/** Nobody has signed in, or the system ended the sign-in. Someone has to sign in again in a browser. */
export class NotSignedIn extends Schema.TaggedError<NotSignedIn>()("NotSignedIn", {}) {
  /** What a caller on the other side of a binding reads. */
  override get message(): string {
    return "nobody is signed in"
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

/** The system's sign-in server did not answer, or answered with something a sign-in cannot go on from. */
export class GrantFailed extends Schema.TaggedError<GrantFailed>()("GrantFailed", {
  operation: Schema.Literals(["discover", "register", "exchange", "refresh", "store"]),
  cause: Schema.Defect(),
}) {
  /** What a caller on the other side of a binding reads. It names the step, and no token. */
  override get message(): string {
    return `the sign-in failed at ${this.operation}`
  }
}

const Tokens = Schema.Struct({
  access: Schema.String,
  /** The token that buys the next access token, or null when the system issued none. */
  refresh: Schema.NullOr(Schema.String),
  /** When the access token stops working, in milliseconds since the epoch. */
  expiresAt: Schema.Number,
})

type Tokens = typeof Tokens.Type

/** Where a system's sign-in server takes each step of a sign-in. The system says so itself. */
const Server = Schema.Struct({ authorize: Schema.String, token: Schema.String, register: Schema.String })

/** What the gateway keeps about its sign-in to one system. All of it is secret. */
export const Grant = Schema.TaggedUnion({
  /** Nobody has started a sign-in. */
  Empty: {},
  /** The gateway is a client of the system's sign-in server. A sign-in may be under way, or in place, or both. */
  Registered: {
    target: Target,
    /** The address the system's tokens are issued for, in the system's own spelling. */
    resource: Schema.String,
    server: Server,
    /** The OAuth client the gateway registered for itself, with the address it registered. */
    client: Schema.Struct({ id: Schema.String, redirect: Schema.String }),
    /** A sign-in that was started and not finished. */
    pending: Schema.NullOr(Schema.Struct({ state: Schema.String, verifier: Schema.String })),
    tokens: Schema.NullOr(Tokens),
  },
})

export type Grant = typeof Grant.Type

type Registered = typeof Grant.cases.Registered.Type

/** A grant before anyone signed in. */
export const empty: Grant = Grant.cases.Empty.make({})

/** Where a sign-in stands. */
export const Status = Schema.Literals(["signed-out", "pending", "signed-in"])

export type Status = typeof Status.Type

/** Where a grant stands. A grant with tokens is signed in, whether or not another sign-in is under way. */
export const statusOf = (grant: Grant): Status => {
  if (!Grant.guards.Registered(grant)) return "signed-out"

  if (grant.tokens !== null) return "signed-in"

  return grant.pending === null ? "signed-out" : "pending"
}

/** Where the grant is kept between calls. */
export interface Store {
  readonly load: Effect.Effect<Grant, GrantFailed>
  readonly save: (grant: Grant) => Effect.Effect<void, GrantFailed>
}

/** The gateway's sign-in to one system, as me. */
export interface Interface {
  /**
   * Starts a sign-in and returns the address to open in a browser.
   *
   * The system is asked where its sign-in server is, and the gateway registers itself there as a client, the
   * first time and whenever the target or the redirect changes. `redirect` is where the browser is sent back
   * to: the gateway's own callback route.
   */
  readonly begin: (target: Target, redirect: string) => Effect.Effect<string, GrantFailed>
  /** Finishes a sign-in with the address the browser was sent back to. */
  readonly complete: (callback: URL) => Effect.Effect<void, UnknownSignIn | GrantFailed>
  /**
   * A token the system accepts. It is renewed first when it is about to expire.
   *
   * A renewal the system refuses ends the sign-in: the tokens are dropped, and this fails with `NotSignedIn`
   * from then on.
   */
  readonly token: Effect.Effect<Redacted.Redacted<string>, NotSignedIn | GrantFailed>
  /** Marks the access token as used up, after the system refused it, so that the next `token` renews it. */
  readonly expire: Effect.Effect<void, GrantFailed>
  /** Where the sign-in stands. */
  readonly status: Effect.Effect<Status, GrantFailed>
}

/** The gateway's grant to act on one system. */
export class Service extends Context.Service<Service, Interface>()("@ratchet/gateway/Grant") {}

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

/** The address that asks me to let the gateway act on a system. */
export const authorizeUrl = (request: {
  readonly authorize: string
  readonly client: string
  readonly redirect: string
  readonly state: string
  readonly challenge: string
  readonly resource: string
  readonly scope: string | null
}): string => {
  const url = new URL(request.authorize)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("client_id", request.client)
  url.searchParams.set("redirect_uri", request.redirect)
  url.searchParams.set("state", request.state)
  url.searchParams.set("code_challenge", request.challenge)
  url.searchParams.set("code_challenge_method", "S256")
  url.searchParams.set("resource", request.resource)

  if (request.scope !== null) url.searchParams.set("scope", request.scope)

  return url.toString()
}

/** Whether a token should be renewed now: it expires within a minute. */
export const expiresSoon = (tokens: Pick<Tokens, "expiresAt">, now: number): boolean => tokens.expiresAt - now < 60_000

/**
 * Where a system describes its sign-in, read from how it refuses a request without a token.
 *
 * A system that does not say is asked at the address RFC 9728 gives for its resource.
 */
export const metadataUrl = (resource: URL, challenge: string | undefined): string => {
  const named = /resource_metadata="([^"]+)"/.exec(challenge ?? "")?.[1]
  const path = resource.pathname === "/" ? "" : resource.pathname

  return named ?? `${resource.origin}/.well-known/oauth-protected-resource${path}`
}

/** Where a sign-in server describes itself: the address RFC 8414 gives for its issuer. */
export const serverMetadataUrl = (issuer: URL): string =>
  `${issuer.origin}/.well-known/oauth-authorization-server${issuer.pathname === "/" ? "" : issuer.pathname}`

const Protected = Schema.Struct({
  resource: Schema.String,
  authorization_servers: Schema.NonEmptyArray(Schema.String),
})

const Described = Schema.Struct({
  authorization_endpoint: Schema.String,
  token_endpoint: Schema.String,
  registration_endpoint: Schema.String,
})

const ClientRegistered = Schema.Struct({ client_id: Schema.String })

const Issued = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Number),
})

const Refused = Schema.Struct({ error: Schema.String })

/** What a sign-in server answers at its token endpoint: tokens, or why not. */
const TokenAnswer = Schema.Union([Issued, Refused])

const isRefused = Schema.is(Refused)

const parseUrl = Schema.decodeUnknownEffect(Schema.URLFromString)

/** Builds the grant on a store and an HTTP client. Nothing is sent until an operation runs. */
export const make = (store: Store): Effect.Effect<Interface, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const plain = yield* HttpClient.HttpClient
    const http = HttpClient.filterStatusOk(plain)

    const described = <A>(url: string, schema: Schema.Codec<A, unknown>) =>
      HttpClientRequest.get(url).pipe(
        HttpClientRequest.acceptJson,
        http.execute,
        Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
      )

    /** Asks the system where its sign-in server is, and that server where it takes each step. */
    const discover = Effect.fn("Grant.discover")(
      function* (target: Target) {
        const resource = yield* parseUrl(target.resource)
        const refusal = yield* plain.execute(HttpClientRequest.get(target.resource))
        const protectedResource = yield* described(metadataUrl(resource, refusal.headers["www-authenticate"]), Protected)
        const issuer = yield* parseUrl(protectedResource.authorization_servers[0])
        const server = yield* described(serverMetadataUrl(issuer), Described)

        return {
          resource: protectedResource.resource,
          server: {
            authorize: server.authorization_endpoint,
            token: server.token_endpoint,
            register: server.registration_endpoint,
          },
        }
      },
      Effect.mapError((cause) => new GrantFailed({ operation: "discover", cause })),
    )

    const register = Effect.fn("Grant.register")(function* (target: Target, redirect: string) {
      const { resource, server } = yield* discover(target)

      const registered = yield* HttpClientRequest.post(server.register).pipe(
        HttpClientRequest.bodyJsonUnsafe({
          client_name: "Ratchet",
          redirect_uris: [redirect],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
          // A scope that is not set is left out of the body.
          scope: target.scope ?? undefined,
        }),
        http.execute,
        Effect.flatMap(HttpClientResponse.schemaBodyJson(ClientRegistered)),
        Effect.mapError((cause) => new GrantFailed({ operation: "register", cause })),
      )

      return Grant.cases.Registered.make({
        target,
        resource,
        server,
        client: { id: registered.client_id, redirect },
        pending: null,
        tokens: null,
      })
    })

    /**
     * Asks the token endpoint for tokens. A refusal is an answer, not a failure: it is the server's word for
     * why, such as `invalid_grant` for a refresh token it no longer honours.
     */
    const issue = (operation: "exchange" | "refresh", grant: Registered, form: Readonly<Record<string, string>>) =>
      Effect.gen(function* () {
        const answer = yield* HttpClientRequest.post(grant.server.token).pipe(
          HttpClientRequest.bodyUrlParams({ ...form, client_id: grant.client.id, resource: grant.resource }),
          HttpClientRequest.acceptJson,
          plain.execute,
          Effect.flatMap(HttpClientResponse.schemaBodyJson(TokenAnswer)),
          Effect.mapError((cause) => new GrantFailed({ operation, cause })),
        )

        if (isRefused(answer)) return Result.fail(answer.error)

        const now = yield* Clock.currentTimeMillis

        const tokens: Tokens = {
          access: answer.access_token,
          // A server that rotates refresh tokens sends the next one. One that does not sends none, and the old one stays good.
          refresh: answer.refresh_token ?? grant.tokens?.refresh ?? null,
          expiresAt: now + (answer.expires_in ?? 3600) * 1000,
        }

        return Result.succeed(tokens)
      })

    const sameSignIn = (grant: Grant, target: Target, redirect: string): grant is Registered =>
      Grant.guards.Registered(grant) &&
      grant.target.resource === target.resource &&
      grant.target.scope === target.scope &&
      grant.client.redirect === redirect

    const begin = Effect.fn("Grant.begin")(function* (target: Target, redirect: string) {
      const grant = yield* store.load
      // A client is registered for one system and one address, so another of either needs another client.
      const registered = sameSignIn(grant, target, redirect) ? grant : yield* register(target, redirect)
      const state = yield* randomToken
      const verifier = yield* randomToken
      yield* store.save({ ...registered, pending: { state, verifier } })

      return authorizeUrl({
        authorize: registered.server.authorize,
        client: registered.client.id,
        redirect,
        state,
        challenge: yield* challengeOf(verifier),
        resource: registered.resource,
        scope: target.scope,
      })
    })

    const complete = Effect.fn("Grant.complete")(function* (callback: URL) {
      const grant = yield* store.load
      const code = callback.searchParams.get("code")
      const refused = callback.searchParams.get("error")

      if (!Grant.guards.Registered(grant) || grant.pending === null) {
        return yield* new UnknownSignIn({ problem: "no sign-in was started" })
      }

      if (refused !== null) return yield* new UnknownSignIn({ problem: `the sign-in was refused: ${refused}` })

      if (code === null || callback.searchParams.get("state") !== grant.pending.state) {
        return yield* new UnknownSignIn({ problem: "the address does not belong to the sign-in that was started" })
      }

      const issued = yield* issue("exchange", grant, {
        grant_type: "authorization_code",
        code,
        redirect_uri: grant.client.redirect,
        code_verifier: grant.pending.verifier,
      })

      if (Result.isFailure(issued)) return yield* new GrantFailed({ operation: "exchange", cause: issued.failure })

      yield* store.save({ ...grant, pending: null, tokens: issued.success })
    })

    const token = Effect.gen(function* () {
      const grant = yield* store.load

      if (!Grant.guards.Registered(grant) || grant.tokens === null) return yield* new NotSignedIn()

      if (!expiresSoon(grant.tokens, yield* Clock.currentTimeMillis)) return Redacted.make(grant.tokens.access)

      const ended = store.save({ ...grant, tokens: null }).pipe(Effect.andThen(Effect.fail(new NotSignedIn())))

      if (grant.tokens.refresh === null) return yield* ended

      const issued = yield* issue("refresh", grant, { grant_type: "refresh_token", refresh_token: grant.tokens.refresh })

      if (Result.isFailure(issued)) {
        // The server no longer honours the refresh token. Asking again would get the same answer.
        return issued.failure === "invalid_grant"
          ? yield* ended
          : yield* new GrantFailed({ operation: "refresh", cause: issued.failure })
      }

      yield* store.save({ ...grant, tokens: issued.success })

      return Redacted.make(issued.success.access)
    }).pipe(Effect.withSpan("Grant.token"))

    const expire = Effect.gen(function* () {
      const grant = yield* store.load

      if (!Grant.guards.Registered(grant) || grant.tokens === null) return

      yield* store.save({ ...grant, tokens: { ...grant.tokens, expiresAt: 0 } })
    }).pipe(Effect.withSpan("Grant.expire"))

    return Service.of({ begin, complete, token, expire, status: Effect.map(store.load, statusOf) })
  })

/** The grant on a store, still in need of an HTTP client. */
export const layerWithoutDependencies = (store: Store): Layer.Layer<Service, never, HttpClient.HttpClient> =>
  Layer.effect(Service, make(store))

/** The grant on a store, over `fetch`. */
export const layer = (store: Store): Layer.Layer<Service> =>
  layerWithoutDependencies(store).pipe(Layer.provide(FetchHttpClient.layer))
