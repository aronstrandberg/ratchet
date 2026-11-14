import { Effect, Layer, Schema } from "effect"
import type { Gateway } from "../gateway/entrypoint.ts"
import { SessionId } from "../protocol/ids.ts"
import { ReadReply, keyOf } from "../protocol/resource.ts"
import * as ResourceSource from "./resource-source.ts"
import * as SessionControl from "./session-control.ts"

const decodeSession = Schema.decodeUnknownEffect(SessionId)
const decodeReply = Schema.decodeUnknownEffect(ReadReply)

/**
 * The hub's ports to the outside, carried out by the gateway over its service binding.
 *
 * A rejected call and an answer the hub cannot read both become the port's own failure.
 */
export const layer = (
  gateway: Service<Gateway>,
): Layer.Layer<SessionControl.Service | ResourceSource.Service> => {
  const control = SessionControl.Service.of({
    recordTask: (session, task) =>
      Effect.tryPromise({
        try: () => gateway.recordTask(session, task),
        catch: (cause) => new SessionControl.SessionControlFailed({ operation: "record task", session, cause }),
      }),
    fork: (session, title, prompt) =>
      Effect.tryPromise(() => gateway.forkSession(session, title, prompt)).pipe(
        Effect.flatMap(decodeSession),
        Effect.mapError((cause) => new SessionControl.SessionControlFailed({ operation: "fork", session, cause })),
      ),
    wake: (wake) =>
      Effect.tryPromise({
        try: () => gateway.wake(wake),
        catch: (cause) => new SessionControl.SessionControlFailed({ operation: "wake", session: wake.session, cause }),
      }),
  })

  const source = ResourceSource.Service.of({
    read: (ref) => {
      const resource = keyOf(ref)
      const unreadable = (cause: unknown) => new ResourceSource.ResourceUnreadable({ resource, cause })

      return Effect.tryPromise(async () => await gateway.readResource(ref)).pipe(
        Effect.flatMap(decodeReply),
        Effect.mapError(unreadable),
        Effect.flatMap(
          ReadReply.match({
            Read: ({ observed }) => Effect.succeed(observed),
            NotFound: () => Effect.fail(new ResourceSource.ResourceNotFound({ resource })),
            NotSignedIn: ({ system }) => Effect.fail(new ResourceSource.ResourceNotSignedIn({ resource, system })),
            Unavailable: ({ message }) => Effect.fail(unreadable(message)),
          }),
        ),
      )
    },
  })

  return Layer.mergeAll(Layer.succeed(SessionControl.Service, control), Layer.succeed(ResourceSource.Service, source))
}
