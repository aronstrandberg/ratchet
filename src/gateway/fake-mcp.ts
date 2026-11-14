import { Schema } from "effect"

const Message = Schema.Struct({
  id: Schema.optional(Schema.Number),
  method: Schema.String,
  params: Schema.optional(
    Schema.Struct({
      name: Schema.optional(Schema.String),
      arguments: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
    }),
  ),
})

const readMessage = Schema.decodeUnknownPromise(Message)

/** What a tool of the stand-in answers: a value, or its word for why it failed. */
export type ToolAnswer = { readonly value: Schema.Json } | { readonly problem: string }

/** A tool of the stand-in: what it answers for the input it is called with. */
export type Tool = (input: Readonly<Record<string, Schema.Json>>) => ToolAnswer

/**
 * A stand-in for a system's MCP server over HTTP, with the tools given.
 *
 * It keeps one session at a time and refuses a call without it, as a server that keeps sessions does. `streamed`
 * answers on an event stream, as Linear's server does; otherwise it answers in the body with structured
 * content, as incident.io's does. Whoever serves it checks the token first.
 */
export const make = (tools: Readonly<Record<string, Tool>>, options: { readonly streamed: boolean }) => {
  let sessions = 1

  const reply = (id: number | undefined, result: Schema.Json, headers: Readonly<Record<string, string>> = {}) => {
    const message = { jsonrpc: "2.0", id: id ?? null, result }

    return options.streamed
      ? new Response(`event: message\ndata: ${JSON.stringify(message)}\n\n`, {
          headers: { ...headers, "content-type": "text/event-stream" },
        })
      : Response.json(message, { headers })
  }

  return {
    /** Answers one message of the protocol: opening a session, or calling a tool. */
    fetch: async (request: Request): Promise<Response> => {
      const message = await readMessage(await request.json())

      if (message.method === "initialize") {
        const opened = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "stand-in", version: "1" } }

        return reply(message.id, opened, { "mcp-session-id": `session-${sessions}` })
      }

      if (request.headers.get("mcp-session-id") !== `session-${sessions}`) {
        return new Response("no such session\n", { status: 404 })
      }

      if (message.method !== "tools/call") return new Response(null, { status: 202 })

      const tool = tools[message.params?.name ?? ""]
      const answer: ToolAnswer = tool === undefined ? { problem: "no such tool" } : tool(message.params?.arguments ?? {})

      if ("problem" in answer) return reply(message.id, { isError: true, content: [{ type: "text", text: answer.problem }] })

      const content = [{ type: "text", text: JSON.stringify(answer.value) }]

      return reply(message.id, options.streamed ? { content } : { content, structuredContent: answer.value })
    },
    /** Forgets the session, as a server does after a while. A client has to open a new one. */
    forget: (): void => {
      sessions += 1
    },
  }
}
