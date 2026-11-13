import { expect, test } from "bun:test"
import { Effect } from "effect"
import { authorizeUrl, challengeOf, expiresSoon } from "./proxy-grant.ts"

test("the sign-in address asks for a token the proxy accepts, bound to this sign-in", async () => {
  // The verifier and challenge of RFC 7636, appendix B.
  const challenge = await Effect.runPromise(challengeOf("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"))
  expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")

  const url = new URL(
    authorizeUrl({ client: "c1", redirect: "http://127.0.0.1:9876/gateway/proxy/callback", state: "s1", challenge }),
  )

  expect(Object.fromEntries(url.searchParams)).toEqual({
    response_type: "code",
    client_id: "c1",
    redirect_uri: "http://127.0.0.1:9876/gateway/proxy/callback",
    scope: "openid offline",
    state: "s1",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: "https://lov-webhook-proxy.lovable.app/api/public/mcp",
  })
})

test("a token is renewed in its last minute, not before", () => {
  const tokens = { access: "a", refresh: "r", expiresAt: 1_000_000 }

  expect(expiresSoon(tokens, 1_000_000 - 61_000)).toBe(false)
  expect(expiresSoon(tokens, 1_000_000 - 59_000)).toBe(true)
})
