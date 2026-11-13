import { Effect, Layer, Schema } from "effect"
import type { Gateway } from "../gateway/entrypoint.ts"
import { SessionId } from "../protocol/ids.ts"
import { ReadReply, keyOf } from "../protocol/pull-request.ts"
import * as PullRequestSource from "./pull-request-source.ts"
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
): Layer.Layer<SessionControl.Service | PullRequestSource.Service> => {
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

  const source = PullRequestSource.Service.of({
    read: (ref) => {
      const pullRequest = keyOf(ref)
      const unreadable = (cause: unknown) => new PullRequestSource.PullRequestUnreadable({ pullRequest, cause })

      return Effect.tryPromise(async () => await gateway.readPullRequest(ref)).pipe(
        Effect.flatMap(decodeReply),
        Effect.mapError(unreadable),
        Effect.flatMap(
          ReadReply.match({
            Read: ({ facts }) => Effect.succeed(facts),
            NotFound: () => Effect.fail(new PullRequestSource.PullRequestNotFound({ pullRequest })),
            Unavailable: ({ message }) => Effect.fail(unreadable(message)),
          }),
        ),
      )
    },
  })

  return Layer.mergeAll(Layer.succeed(SessionControl.Service, control), Layer.succeed(PullRequestSource.Service, source))
}
