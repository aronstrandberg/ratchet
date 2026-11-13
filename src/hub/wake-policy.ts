import { Context, Result, Schema } from "effect"
import { SessionId } from "../protocol/ids.ts"

/** Which sessions Ratchet may put a message into. */
export const WakePolicy = Schema.TaggedUnion({
  Nobody: {},
  Everybody: {},
  Only: { sessions: Schema.Array(SessionId) },
})

export type WakePolicy = typeof WakePolicy.Type

/** A wake setting names something that is not a session ID. */
export class InvalidWakeSetting extends Schema.TaggedError<InvalidWakeSetting>()("InvalidWakeSetting", {
  entry: Schema.String,
}) {
  override get message(): string {
    return `"${this.entry}" is not a session ID`
  }
}

const parseSession = Schema.decodeUnknownResult(SessionId)

/**
 * Parses the `WAKE_SESSIONS` setting: `*` for every session, session IDs separated by commas for those
 * sessions, and nothing for no session.
 */
export const parse = (setting: string): Result.Result<WakePolicy, InvalidWakeSetting> => {
  const entries = setting
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")

  if (entries.includes("*")) return Result.succeed(WakePolicy.cases.Everybody.make({}))

  if (entries.length === 0) return Result.succeed(WakePolicy.cases.Nobody.make({}))

  const sessions: Array<SessionId> = []

  for (const entry of entries) {
    const session = parseSession(entry)

    if (Result.isFailure(session)) return Result.fail(new InvalidWakeSetting({ entry }))
    sessions.push(session.success)
  }

  return Result.succeed(WakePolicy.cases.Only.make({ sessions }))
}

/** Whether the policy lets Ratchet wake this session. */
export const allows = (policy: WakePolicy, session: SessionId): boolean =>
  WakePolicy.match(policy, {
    Nobody: () => false,
    Everybody: () => true,
    Only: ({ sessions }) => sessions.includes(session),
  })

/** The wake policy in force, chosen where the hub is put together. */
export class Service extends Context.Service<Service, WakePolicy>()("@ratchet/hub/WakePolicy") {}
