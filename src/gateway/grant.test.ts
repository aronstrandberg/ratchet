import { afterAll, expect, test } from "bun:test"
import { Effect, Redacted } from "effect"
import { FetchHttpClient } from "effect/http"
import * as FakeSignIn from "./fake-sign-in.ts"
import * as Grant from "./grant.ts"

// A system with a sign-in, on a port of its own: one protected address, and the sign-in server beside it.
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: async (request) => {
    const answer = await system.fetch(request)

    if (answer !== null) return answer

    return system.accepts(request) ? Response.json({ ok: true }) : system.refusal(new URL(request.url).pathname)
  },
})

const origin = `http://127.0.0.1:${server.port}`
const system = FakeSignIn.make(origin)
const target: Grant.Target = { resource: `${origin}/mcp`, scope: "read" }
const redirect = "http://127.0.0.1:9876/gateway/sign-ins/linear/callback"

afterAll(() => server.stop(true))

/** A grant that keeps its state in memory, over the real `fetch`. */
const grantInMemory = () => {
  let held = Grant.empty

  return Grant.make({
    load: Effect.sync(() => held),
    save: (grant) =>
      Effect.sync(() => {
        held = grant
      }),
  }).pipe(Effect.provide(FetchHttpClient.layer))
}

/** Opens the sign-in address as a browser would, and returns where the system sends the browser back to. */
const approve = (address: string) =>
  Effect.promise(async () => new URL((await fetch(address, { redirect: "manual" })).headers.get("location") ?? ""))

const good = (token: Redacted.Redacted<string>) =>
  system.accepts(new Request(target.resource, { headers: { authorization: `Bearer ${Redacted.value(token)}` } }))

const signedIn = Effect.gen(function* () {
  const grant = yield* grantInMemory()
  yield* grant.complete(yield* approve(yield* grant.begin(target, redirect)))

  return grant
})

test("a sign-in finds the system's sign-in server, registers there and ends with a token the system accepts", async () => {
  const [address, status, accepted] = await Effect.runPromise(
    Effect.gen(function* () {
      const grant = yield* grantInMemory()
      const address = new URL(yield* grant.begin(target, redirect))
      yield* grant.complete(yield* approve(address.toString()))

      return [address, yield* grant.status, good(yield* grant.token)] as const
    }),
  )

  expect(`${address.origin}${address.pathname}`).toBe(`${origin}/oauth/authorize`)
  // The token is asked for the address the system protects, and for no more than the scope given.
  expect(address.searchParams.get("resource")).toBe(target.resource)
  expect(address.searchParams.get("scope")).toBe("read")
  expect(address.searchParams.get("code_challenge_method")).toBe("S256")
  expect(status).toBe("signed-in")
  expect(accepted).toBe(true)
})

test("each renewal uses the refresh token the renewal before it issued", async () => {
  const accepted = await Effect.runPromise(
    Effect.gen(function* () {
      const grant = yield* signedIn
      const first = yield* grant.token

      // The system honours a refresh token once, so a second renewal with the first one would be refused.
      system.expire()
      yield* grant.expire
      const second = yield* grant.token
      system.expire()
      yield* grant.expire
      const third = yield* grant.token

      return [good(first), good(second), good(third)]
    }),
  )

  expect(accepted).toEqual([false, false, true])
})

test("a renewal the system refuses ends the sign-in, and the next call does not ask again", async () => {
  const [first, second, status] = await Effect.runPromise(
    Effect.gen(function* () {
      const grant = yield* signedIn
      system.revoke()
      yield* grant.expire

      return [yield* Effect.flip(grant.token), yield* Effect.flip(grant.token), yield* grant.status] as const
    }),
  )

  expect(first).toBeInstanceOf(Grant.NotSignedIn)
  expect(second).toBeInstanceOf(Grant.NotSignedIn)
  expect(status).toBe("signed-out")
})

test("an address from another sign-in does not finish this one", async () => {
  const failure = await Effect.runPromise(
    Effect.gen(function* () {
      const grant = yield* grantInMemory()
      const back = yield* approve(yield* grant.begin(target, redirect))
      back.searchParams.set("state", "someone-else")

      return yield* Effect.flip(grant.complete(back))
    }),
  )

  expect(failure).toBeInstanceOf(Grant.UnknownSignIn)
})

test("a system is asked where its sign-in is described, at the address it names or the one RFC 9728 gives", () => {
  const resource = new URL("https://mcp.incident.io/mcp")
  const named = 'Bearer resource_metadata="https://mcp.incident.io/mcp/.well-known/oauth-protected-resource"'

  expect(Grant.metadataUrl(resource, named)).toBe("https://mcp.incident.io/mcp/.well-known/oauth-protected-resource")
  expect(Grant.metadataUrl(resource, undefined)).toBe("https://mcp.incident.io/.well-known/oauth-protected-resource/mcp")
  expect(Grant.serverMetadataUrl(new URL("https://lovable.dev/oauth"))).toBe(
    "https://lovable.dev/.well-known/oauth-authorization-server/oauth",
  )
})

test("a token is renewed in its last minute, not before", () => {
  expect(Grant.expiresSoon({ expiresAt: 1_000_000 }, 1_000_000 - 61_000)).toBe(false)
  expect(Grant.expiresSoon({ expiresAt: 1_000_000 }, 1_000_000 - 59_000)).toBe(true)
})
