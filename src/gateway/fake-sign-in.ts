import { Schema } from "effect"

const Registration = Schema.Struct({ redirect_uris: Schema.Array(Schema.String) })
const readRegistration = Schema.decodeUnknownPromise(Registration)

const sha256 = async (text: string) =>
  btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "")

const refuse = (error: string) => Response.json({ error }, { status: 400 })

/**
 * A stand-in for a system's sign-in: the OAuth server and the two documents a client finds it by.
 *
 * It signs everyone in without asking, checks the PKCE verifier, and issues a new refresh token with each
 * renewal and honours each one once, as the real servers do. A test or a scratch Ratchet serves it under its
 * own origin and asks it whether a token is good.
 */
export const make = (origin: string) => {
  const clients = new Map<string, ReadonlyArray<string>>()
  const codes = new Map<string, { readonly client: string; readonly challenge: string }>()
  const access = new Set<string>()
  const refresh = new Set<string>()
  let issued = 0

  const tokens = () => {
    issued += 1
    access.add(`access-${issued}`)
    refresh.add(`refresh-${issued}`)

    return Response.json({ access_token: `access-${issued}`, refresh_token: `refresh-${issued}`, expires_in: 3600 })
  }

  const token = async (request: Request) => {
    const form = new URLSearchParams(await request.text())

    if (form.get("grant_type") === "refresh_token") {
      // A refresh token is honoured once: the renewal issues the next one.
      return refresh.delete(form.get("refresh_token") ?? "") ? tokens() : refuse("invalid_grant")
    }

    const code = codes.get(form.get("code") ?? "")

    if (code === undefined || code.client !== form.get("client_id")) return refuse("invalid_grant")

    codes.delete(form.get("code") ?? "")

    return (await sha256(form.get("code_verifier") ?? "")) === code.challenge ? tokens() : refuse("invalid_grant")
  }

  const authorize = (url: URL) => {
    const client = url.searchParams.get("client_id") ?? ""
    const redirect = url.searchParams.get("redirect_uri") ?? ""

    if (clients.get(client)?.includes(redirect) !== true) return refuse("invalid_client")

    const code = `code-${codes.size + 1}`
    codes.set(code, { client, challenge: url.searchParams.get("code_challenge") ?? "" })

    const back = new URL(redirect)
    back.searchParams.set("code", code)
    back.searchParams.set("state", url.searchParams.get("state") ?? "")

    return Response.redirect(back.toString(), 302)
  }

  return {
    /** Answers a request to the sign-in server or for one of its documents, or null for any other request. */
    fetch: async (request: Request): Promise<Response | null> => {
      const url = new URL(request.url)

      if (url.pathname.startsWith("/.well-known/oauth-protected-resource/")) {
        const path = url.pathname.slice("/.well-known/oauth-protected-resource".length)

        return Response.json({ resource: `${origin}${path}`, authorization_servers: [`${origin}/oauth`] })
      }

      switch (url.pathname) {
        case "/.well-known/oauth-authorization-server/oauth":
          return Response.json({
            issuer: `${origin}/oauth`,
            authorization_endpoint: `${origin}/oauth/authorize`,
            token_endpoint: `${origin}/oauth/token`,
            registration_endpoint: `${origin}/oauth/register`,
          })
        case "/oauth/register": {
          const client = `client-${clients.size + 1}`
          clients.set(client, (await readRegistration(await request.json())).redirect_uris)

          return Response.json({ client_id: client }, { status: 201 })
        }

        case "/oauth/authorize":
          return authorize(url)
        case "/oauth/token":
          return token(request)
        default:
          return null
      }
    },
    /** Whether a request carries a token this server issued and has not withdrawn. */
    accepts: (request: Request): boolean => access.has((request.headers.get("authorization") ?? "").replace(/^Bearer /, "")),
    /** How a protected address refuses a request without a good token: it names where its sign-in is described. */
    refusal: (path: string): Response =>
      new Response("sign in first\n", {
        status: 401,
        headers: { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource${path}"` },
      }),
    /** Withdraws every access token, as when they run out. A client renews with its refresh token. */
    expire: (): void => access.clear(),
    /** Ends every sign-in: no token is good and no refresh token is honoured. */
    revoke: (): void => {
      access.clear()
      refresh.clear()
    },
  }
}
