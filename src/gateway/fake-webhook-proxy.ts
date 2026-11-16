import { Schema } from "effect"

/** A GitHub event as a test or a scratch Ratchet has the stand-in send it. */
export const Sent = Schema.Struct({
  repo: Schema.String,
  prs: Schema.Array(Schema.Number),
  event_type: Schema.String,
  action: Schema.optional(Schema.String),
  conclusion: Schema.optional(Schema.String),
})

export type Sent = typeof Sent.Type

/** One connection to the stand-in's stream: what it asked for, and how to write to it. */
interface Connection {
  readonly scopes: ReadonlyArray<string>
  /** The cursor the connection was opened with, or null. */
  readonly cursor: string | null
  readonly controller: ReadableStreamDefaultController<Uint8Array>
}

/**
 * A stand-in for the webhook proxy's stream of GitHub events.
 *
 * It sends an event to every connection whose scopes name one of the event's pull requests, says it is there
 * every `heartbeat` milliseconds, and remembers what each connection asked for. Whoever serves it says
 * whether the token is good.
 */
export const make = (options: { readonly heartbeat: number }) => {
  const encoder = new TextEncoder()
  const open = new Set<Connection>()
  const opened: Array<{ readonly scopes: ReadonlyArray<string>; readonly cursor: string | null }> = []
  let sent = 0

  const write = (connection: Connection, text: string) => {
    try {
      connection.controller.enqueue(encoder.encode(text))
    } catch {
      open.delete(connection)
    }
  }

  // An ID that sorts by when it was made, as the proxy's do.
  const next = () => `0190a000-0000-7000-8000-${String(++sent).padStart(12, "0")}`
  const last = () => (sent === 0 ? null : `0190a000-0000-7000-8000-${String(sent).padStart(12, "0")}`)

  const beat = setInterval(() => {
    const cursor = last()

    for (const connection of open) write(connection, cursor === null ? ": ping\n\n" : `id: ${cursor}\n: ping\n\n`)
  }, options.heartbeat)

  return {
    /** Opens a stream for the scopes in the request, or refuses a request whose token is not good. */
    fetch: (request: Request, accepted: boolean): Response => {
      if (!accepted) return new Response("Sign in required\n", { status: 401 })

      const url = new URL(request.url)
      const scopes = url.searchParams.getAll("scope").flatMap((scope) => scope.split(","))
      const cursor = request.headers.get("last-event-id")
      let connection: Connection | undefined

      const body = new ReadableStream<Uint8Array>({
        start: (controller) => {
          connection = { scopes, cursor, controller }
          open.add(connection)
          opened.push({ scopes, cursor })
          write(connection, "retry: 1000\n\n: ping\n\n")
        },
        cancel: () => {
          if (connection !== undefined) open.delete(connection)
        },
      })

      return new Response(body, { headers: { "content-type": "text/event-stream; charset=utf-8" } })
    },
    /** Sends an event to the connections it concerns, and answers its ID. */
    emit: (event: Sent): string => {
      const id = next()
      const data = { id, source: "github", action: null, delivery_id: null, ...event }

      for (const connection of open) {
        const concerned = event.prs.some((number) => connection.scopes.includes(`${event.repo}#${number}`))

        if (concerned) write(connection, `id: ${id}\nevent: event\ndata: ${JSON.stringify(data)}\n\n`)
      }

      return id
    },
    /** Tells every connection that events were missed. */
    gap: (): void => {
      for (const connection of open) write(connection, `event: gap\ndata: {"after":"x"}\n\n`)
    },
    /** Closes every connection, as the proxy does about every ten minutes. */
    close: (): void => {
      for (const connection of open) connection.controller.close()
      open.clear()
    },
    /** What each connection asked for, in the order they were opened. */
    opened: (): ReadonlyArray<{ readonly scopes: ReadonlyArray<string>; readonly cursor: string | null }> => opened,
    /** Stops the heartbeat. */
    stop: (): void => clearInterval(beat),
  }
}
