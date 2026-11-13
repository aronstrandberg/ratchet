import { expect, test } from "bun:test"
import { Result } from "effect"
import { SessionId } from "../protocol/ids.ts"
import * as WakePolicy from "./wake-policy.ts"

const session = SessionId.make("ses_1")

const allowed = (setting: string) => Result.map(WakePolicy.parse(setting), (policy) => WakePolicy.allows(policy, session))

test("the wake setting names every session, some sessions or none, and refuses anything else", () => {
  expect(allowed("*")).toEqual(Result.succeed(true))
  expect(allowed("ses_2, ses_1")).toEqual(Result.succeed(true))
  expect(allowed("ses_2")).toEqual(Result.succeed(false))
  expect(allowed("")).toEqual(Result.succeed(false))
  expect(Result.isFailure(allowed("everyone"))).toBe(true)
})
