import { expect, test } from "bun:test"
import { Schema } from "effect"
import { TaskId } from "../protocol/ids.ts"
import { sessionMachine, tasksOf } from "./session.ts"
import { isUnborn, taskMachine } from "./task.ts"

// A cell's snapshot is the only record of the events folded into it, so a state that gains a field must
// still decode the JSON that was stored without it.

const storedSession = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.toCodecJson(sessionMachine.stateSchema)))

test("a session stored before sessions remembered their earlier tasks still loads", () => {
  expect(tasksOf(storedSession('{"_tag":"Bound","task":"tsk_1"}'))).toEqual([TaskId.make("tsk_1")])
})

const storedTask = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.toCodecJson(taskMachine.stateSchema)))

test("a task stored before a followed resource could end still loads, with the resource not ended", () => {
  const state = storedTask(
    '{"_tag":"NeedsMe","title":"t","parent":null,"sessions":["ses_1"],"running":[],"subagents":[],"questions":[],' +
      '"attachments":[{"resource":"o/r#1","relation":"owns","session":"ses_1","status":"waiting-user","note":"n"}],' +
      '"outbox":[]}',
  )

  expect(isUnborn(state) ? [] : state.attachments.map((attachment) => attachment.ended)).toEqual([null])
})

const storedTaskEvent = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.toCodecJson(taskMachine.eventSchema)))

test("a wake-up queued before wake-ups carried their time still loads, from a snapshot and from the journal", () => {
  const state = storedTask(
    '{"_tag":"Idle","title":"t","parent":null,"sessions":["ses_1"],"running":[],"subagents":[],"questions":[],' +
      '"attachments":[],"outbox":[{"id":"w1","session":"ses_1","text":"It merged."}]}',
  )

  expect(isUnborn(state) ? [] : state.outbox.map((wake) => wake.queuedAt)).toEqual([0])
  expect(storedTaskEvent('{"_tag":"WakeQueued","id":"w1","session":"ses_1","text":"It merged."}')).toMatchObject({ at: 0 })
})
