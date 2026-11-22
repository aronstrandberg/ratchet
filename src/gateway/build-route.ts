import { BuildReadReply } from "../protocol/build.ts"

/** The gateway operation the build HTTP route calls. */
export interface BuildReader {
  readonly readBuild: (address: string) => Promise<typeof BuildReadReply.Encoded>
}

/** Answers the read-only HTTP route for one Buildkite build. */
export const buildRoute = async (request: Request, gateway: BuildReader): Promise<Response> => {
  if (request.method !== "GET") return new Response("method not allowed\n", { status: 405, headers: { allow: "GET" } })

  const address = new URL(request.url).searchParams.get("url") ?? ""
  const reply = await gateway.readBuild(address)

  return BuildReadReply.match(reply, {
    Read: ({ build }) => Response.json(build),
    BadRequest: ({ message }) => Response.json({ error: message }, { status: 400 }),
    NotFound: () => Response.json({ error: "Buildkite build not found" }, { status: 404 }),
    Unavailable: ({ reason }) =>
      Response.json(
        { error: reason === "not-signed-in" ? "Ratchet is not signed in to Buildkite" : "Buildkite is unavailable" },
        { status: 503 },
      ),
  })
}
