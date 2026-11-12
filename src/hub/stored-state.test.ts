import { expect, test } from "bun:test"
import { Schema } from "effect"
import { sessionMachine, tasksOf } from "./session.ts"

// A cell's snapshot is the only record of the events folded into it, so a state that gains a field must
// still decode the JSON that was stored without it.

const storedSession = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.toCodecJson(sessionMachine.stateSchema)))

test("a session stored before sessions remembered their earlier tasks still loads", () => {
  expect(tasksOf(storedSession('{"_tag":"Bound","task":"tsk_1"}'))).toEqual(["tsk_1"])
})
