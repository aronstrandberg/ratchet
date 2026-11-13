import { expect, test } from "bun:test"
import { Effect } from "effect"
import { SessionId } from "../protocol/ids.ts"
import type { Wake } from "../protocol/wake.ts"
import { messageId } from "./opencode.ts"

const wake: Wake = {
  id: "o/r#1@aaaaaaaaaaaa:Merged",
  session: SessionId.make("ses_1"),
  text: "It merged.",
  queuedAt: 1_794_526_147_816,
}

test("a wake-up sent again becomes the same message, and another wake-up a different one", async () => {
  const [first, again, other] = await Effect.runPromise(
    Effect.all([messageId(wake), messageId({ ...wake }), messageId({ ...wake, id: "o/r#1@aaaaaaaaaaaa:Closed" })]),
  )

  expect(again).toBe(first)
  expect(other).not.toBe(first)
  // OpenCode's own message IDs start with the time: this one was queued in the same millisecond as 1d217f4e8000.
  expect(first).toMatch(/^msg_1d217f4e8000[0-9A-Za-z]{14}$/)
})
