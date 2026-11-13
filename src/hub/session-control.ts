import { Context, type Effect, Schema } from "effect"
import type { SessionId, TaskId } from "../protocol/ids.ts"
import type { Wake } from "../protocol/wake.ts"

/** OpenCode did not carry out what the hub asked of a session. */
export class SessionControlFailed extends Schema.TaggedError<SessionControlFailed>()("SessionControlFailed", {
  operation: Schema.Literals(["record task", "fork", "wake"]),
  session: Schema.String,
  cause: Schema.Defect(),
}) {}

/** What the hub asks OpenCode to do to a session. The gateway carries it out. */
export interface Interface {
  /** Writes the task a session works on into the session's own metadata. */
  readonly recordTask: (session: SessionId, task: TaskId) => Effect.Effect<void, SessionControlFailed>
  /** Forks a session into a new one with the same history, names the fork and prompts it. */
  readonly fork: (session: SessionId, title: string, prompt: string) => Effect.Effect<SessionId, SessionControlFailed>
  /** Puts a wake-up into its session. Sending the same wake-up again adds nothing. */
  readonly wake: (wake: Wake) => Effect.Effect<void, SessionControlFailed>
}

/** The hub's control over OpenCode sessions. */
export class Service extends Context.Service<Service, Interface>()("@ratchet/hub/SessionControl") {}
