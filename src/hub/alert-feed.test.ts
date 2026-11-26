import { expect, test } from "bun:test"
import { Effect } from "effect"
import type { Alert } from "../protocol/alerts.ts"
import { SessionId } from "../protocol/ids.ts"
import { ResourceFacts, ResourceRef } from "../protocol/resource.ts"
import { SessionFact, SessionOrigin } from "../protocol/session.ts"
import * as Resources from "./resources.ts"
import * as Tasks from "./tasks.ts"
import * as TestHub from "./test-hub.ts"

const run = <A, E>(program: Effect.Effect<A, E, TestHub.Services>) =>
  Effect.runPromise(program.pipe(Effect.provide(TestHub.layer())))

const session = SessionId.make("ses_a")
const feed = ResourceRef.cases.AlertFeed.make({ team: "devex" })

const alert = (id: string, firing: boolean): Alert => ({
  id,
  title: `Alert ${id}`,
  firing,
  priority: "Low Urgency",
  teams: ["devex"],
  url: `https://lovable.grafana.net/alerting/${id}`,
  createdAt: 1_000 + id.length,
})

const facts = (alerts: ReadonlyArray<Alert>) =>
  ResourceFacts.cases.AlertFeed.make({ facts: { ref: { team: "devex" }, alerts } })

test("a feed wakes its owner for an alert that starts firing, notes one that resolves, and says nothing of what it had", () =>
  run(
    Effect.gen(function* () {
      const tasks = yield* Tasks.Service
      const resources = yield* Resources.Service
      const outside = yield* TestHub.Control

      yield* tasks.observe([
        SessionFact.cases.Opened.make({
          session,
          title: "Watch the alerts",
          origin: SessionOrigin.cases.Root.make({}),
          running: false,
          subagents: [],
          questions: [],
        }),
      ])
      yield* outside.publish(facts([alert("a1", true)]))
      yield* resources.register(session, feed, "owns")

      expect(yield* resources.observe(facts([alert("a1", true)]))).toMatchObject({ changes: [], woke: 0 })
      expect(yield* resources.observe(facts([alert("a1", true), alert("a22", true)]))).toMatchObject({
        changes: ["Fired"],
        woke: 1,
      })
      expect(yield* resources.observe(facts([alert("a1", false), alert("a22", true)]))).toMatchObject({
        changes: ["Resolved"],
        woke: 1,
      })

      const wakes = yield* outside.wakes

      expect(wakes.map((wake) => [wake.resume, wake.screen])).toEqual([
        [true, false],
        [false, false],
      ])
      expect(wakes[0]?.text).toContain(
        "- Firing (Low Urgency) for devex: Alert a22 https://lovable.grafana.net/alerting/a22",
      )
    }),
  ))
