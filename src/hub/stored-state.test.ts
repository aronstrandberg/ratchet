import { expect, test } from "bun:test"
import { Option, Schema } from "effect"
import { TaskId } from "../protocol/ids.ts"
import { refOf } from "../protocol/resource.ts"
import { pullRequestMachine } from "./pull-request.ts"
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

test("a task stored before tasks held decisions still loads, with no decision open", () => {
  const state = storedTask(
    '{"_tag":"Idle","title":"t","parent":null,"sessions":["ses_1"],"running":[],"subagents":[],"questions":[],' +
      '"attachments":[],"outbox":[]}',
  )

  expect(isUnborn(state) ? null : state.decisions).toEqual([])
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

test("a wake-up queued before wake-ups could carry a card still loads, as one that starts a turn", () => {
  const state = storedTask(
    '{"_tag":"Idle","title":"t","parent":null,"sessions":["ses_1"],"running":[],"subagents":[],"questions":[],' +
      '"attachments":[],"outbox":[{"id":"w1","session":"ses_1","text":"It merged.","queuedAt":5}]}',
  )

  expect(isUnborn(state) ? [] : state.outbox.map(({ card, resume }) => ({ card, resume }))).toEqual([{ card: null, resume: true }])
  expect(storedTaskEvent('{"_tag":"WakeQueued","id":"w1","session":"ses_1","text":"It merged.","at":5}')).toMatchObject({
    card: null,
    resume: true,
  })
})

const storedPullRequestEvent = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.toCodecJson(pullRequestMachine.eventSchema)),
)

test("an observation journaled before pull requests carried their merge commit still loads, with none", () => {
  const event = storedPullRequestEvent(
    '{"_tag":"Observed","facts":{"ref":{"owner":"o","repo":"r","number":1},"title":"t","state":"merged","draft":false,' +
      '"head":"aaa","mergeable":"unknown","reviewDecision":null,"queued":false,"checks":[],"threads":[],"reviews":[],"viewer":"me"}}',
  )

  expect(event).toMatchObject({ facts: { mergeCommit: null } })
})

test("a task that follows a commit's builds under their first key, the hash alone, still loads", () => {
  const state = storedTask(
    '{"_tag":"Idle","title":"t","parent":null,"sessions":["ses_1"],"running":[],"subagents":[],"questions":[],' +
      '"attachments":[{"resource":"builds:ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12","relation":"owns","session":"ses_1",' +
      '"status":"unassigned","note":"","ended":null}],"outbox":[]}',
  )

  expect(isUnborn(state) ? [] : state.attachments.map((attachment) => refOf(attachment.resource))).toEqual([Option.none()])
})

const storedPullRequest = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.toCodecJson(pullRequestMachine.stateSchema)))

test("a pull request stored before the cell remembered how CI and code review last ended still loads, as unknown", () => {
  const state = storedPullRequest(
    '{"_tag":"Open","ref":{"owner":"o","repo":"r","number":1},"title":"t","head":"aaa","draft":false,"conflicting":false,' +
      '"reviewDecision":null,"queued":false,"ci":{"_tag":"Running"},"threads":[],"reviews":[],"viewer":"me","subscribers":[]}',
  )

  expect(state).toMatchObject({ finished: null, reviewed: null, reviewChecks: [] })
})
