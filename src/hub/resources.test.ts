import { expect, test } from "bun:test"
import { Effect } from "effect"
import { SessionId } from "../protocol/ids.ts"
import type { IncidentFacts } from "../protocol/incident.ts"
import type { LinearIssueFacts } from "../protocol/linear.ts"
import type { Check, PullRequestFacts } from "../protocol/pull-request.ts"
import { ResourceFacts, ResourceRef } from "../protocol/resource.ts"
import { SessionFact, SessionOrigin } from "../protocol/session.ts"
import * as Index from "./index-store.ts"
import * as Resources from "./resources.ts"
import * as Tasks from "./tasks.ts"
import * as TestHub from "./test-hub.ts"
import { WakePolicy } from "./wake-policy.ts"

const run = <A, E>(program: Effect.Effect<A, E, TestHub.Services>, wake?: WakePolicy) =>
  Effect.runPromise(program.pipe(Effect.provide(TestHub.layer(wake))))

const ref = ResourceRef.cases.PullRequest.make({ owner: "o", repo: "r", number: 1 })
const session = SessionId.make("ses_1")

const facts = (over: Partial<PullRequestFacts> = {}): ResourceFacts =>
  ResourceFacts.cases.PullRequest.make({ facts: { ...pullRequest, ...over } })

const pullRequest: PullRequestFacts = {
  ref: { owner: "o", repo: "r", number: 1 },
  title: "A change",
  state: "open",
  draft: false,
  head: "aaaaaaaaaaaa",
  mergeable: "mergeable",
  reviewDecision: null,
  queued: false,
  checks: [],
  threads: [],
  reviews: [],
  viewer: "me",
}

const check = (name: string, state: Check["state"]): Check => ({ name, state, required: true })

/** A session the hub knows, with `title` as the title of its task, and a resource in its own system. */
const setUp = (title = "Speed up the build", published: ResourceFacts = facts()) =>
  Effect.gen(function* () {
    const tasks = yield* Tasks.Service
    const outside = yield* TestHub.Control

    yield* tasks.observe([
      SessionFact.cases.Opened.make({
        session,
        title,
        origin: SessionOrigin.cases.Root.make({}),
        running: false,
        subagents: [],
        questions: [],
      }),
    ])
    yield* outside.publish(published)

    return { tasks, outside, pullRequests: yield* Resources.Service }
  })

test("a wake-up OpenCode refuses stays queued, and the next delivery sends it once", () =>
  run(
    Effect.gen(function* () {
      const { pullRequests, outside } = yield* setUp("Speed up the build", facts({ checks: [check("build", "pending")] }))
      yield* pullRequests.register(session, ref, "owns")

      yield* outside.refuseWakes(true)
      const observed = yield* pullRequests.observe(facts({ checks: [check("build", "failure")] }))
      expect(observed).toEqual({ changes: ["CiFinished"], woke: 0 })

      yield* outside.refuseWakes(false)
      expect(yield* pullRequests.deliverPending).toBe(1)
      expect(yield* pullRequests.deliverPending).toBe(0)

      const wakes = yield* outside.wakes
      expect(wakes.map((wake) => wake.session)).toEqual([session])
      expect(wakes[0]?.text).toContain("Ratchet: pull request o/r#1 changed.")
      expect(wakes[0]?.text).toContain("CI finished on aaaaaaa with failing required checks: build.")
      expect(wakes[0]?.text).toContain('It belongs to your task "Speed up the build".')
    }),
  ))

test("a task that waits on a pull request hears its merge and not its CI or reviews", () =>
  run(
    Effect.gen(function* () {
      const { pullRequests } = yield* setUp("Speed up the build", facts({ checks: [check("build", "pending")] }))
      yield* pullRequests.register(session, ref, "waits_on")

      const noisy = yield* pullRequests.observe(
        facts({
          checks: [check("build", "failure")],
          reviews: [{ id: "r1", author: "reviewer", state: "changes_requested" }],
        }),
      )

      expect(noisy).toEqual({ changes: ["CiFinished", "ReviewSubmitted"], woke: 0 })
      expect(yield* pullRequests.observe(facts({ state: "merged" }))).toEqual({ changes: ["Merged"], woke: 1 })
    }),
  ))

test("a session the policy does not let Ratchet wake gets no wake-up, and is told so when it registers", () =>
  run(
    Effect.gen(function* () {
      const { pullRequests, outside } = yield* setUp()
      expect((yield* pullRequests.register(session, ref, "owns")).wakes).toBe(false)

      expect(yield* pullRequests.observe(facts({ state: "merged" }))).toEqual({ changes: ["Merged"], woke: 0 })
      expect(yield* pullRequests.deliverPending).toBe(0)
      expect(yield* outside.wakes).toEqual([])
    }),
    WakePolicy.cases.Nobody.make({}),
  ))

test("reporting that a pull request waits on me puts its task in front of me, until it merges", () =>
  run(
    Effect.gen(function* () {
      const { pullRequests, tasks, outside } = yield* setUp()
      yield* pullRequests.register(session, ref, "owns")
      expect((yield* tasks.current(session)).state).toBe("Idle")

      yield* pullRequests.setStatus(session, ref, "waiting-user", "Please merge.")
      expect((yield* tasks.current(session)).state).toBe("NeedsMe")

      // OpenCode refuses the wake-up, and the task still learns that the pull request ended.
      yield* outside.refuseWakes(true)
      yield* pullRequests.observe(facts({ state: "merged" }))
      expect((yield* tasks.current(session)).state).toBe("Idle")
    }),
  ))

test("a status for a pull request no task of the session follows is refused", () =>
  run(
    Effect.gen(function* () {
      const { pullRequests } = yield* setUp()
      const refused = yield* Effect.flip(pullRequests.setStatus(session, ref, "ready", "Nothing left."))

      expect(refused._tag).toBe("NotRegistered")
    }),
  ))

test("a pull request GitHub does not have is refused and not followed", () =>
  run(
    Effect.gen(function* () {
      const { pullRequests } = yield* setUp()
      const other = ResourceRef.cases.PullRequest.make({ owner: "o", repo: "r", number: 2 })
      const missing = yield* Effect.flip(pullRequests.register(session, other, "owns"))

      expect(missing._tag).toBe("ResourceNotFound")
      expect((yield* pullRequests.list(session)).resources).toEqual([])
      expect(yield* Effect.flatMap(Index.Service, (index) => index.resources("all"))).toEqual([])
    }),
  ))

test("a session that started another task still reports on the pull request of its earlier task", () =>
  run(
    Effect.gen(function* () {
      const { pullRequests, tasks } = yield* setUp()
      const first = yield* pullRequests.register(session, ref, "owns")
      const started = yield* tasks.start(session, "Something else", "sibling")
      expect(started.task.id).not.toBe(first.task)

      expect((yield* pullRequests.setStatus(session, ref, "waiting-ci", "Checks run.")).task).toBe(first.task)
      // Registering again does not attach it to the new task as well.
      expect((yield* pullRequests.register(session, ref, "owns")).task).toBe(first.task)

      const following = yield* pullRequests.list(session)
      expect(following.task).toBe(started.task.id)
      expect(following.resources.map(({ task, status }) => ({ task, status }))).toEqual([
        { task: first.task, status: "waiting-ci" },
      ])
      // Someone still follows it and it can change, so it is read again.
      expect(yield* pullRequests.watched).toEqual([ref])
    }),
  ))

test("a wake-up for an earlier task says the session now works on another one", () =>
  run(
    Effect.gen(function* () {
      const { pullRequests, tasks, outside } = yield* setUp("Speed up the build")
      yield* pullRequests.register(session, ref, "owns")
      yield* tasks.start(session, "Something else", "child")
      yield* pullRequests.observe(facts({ state: "merged" }))

      const [wake] = yield* outside.wakes
      expect(wake?.text).toContain('It belongs to "Speed up the build", a task you worked on before the one you work on now.')
    }),
  ))

const issueRef = ResourceRef.cases.LinearIssue.make({ identifier: "DX-1" })

const issue = (over: Partial<LinearIssueFacts> = {}): ResourceFacts =>
  ResourceFacts.cases.LinearIssue.make({
    facts: {
      ref: { identifier: "DX-1" },
      title: "Move the export",
      url: "https://linear.app/lovable/issue/DX-1",
      state: { name: "In Progress", type: "started" },
      assignee: { id: "u-me", name: "me" },
      comments: [],
      viewer: { id: "u-me", name: "me" },
      ...over,
    },
  })

test("the owner of a Linear issue hears another person's comment, and not its own or a move on the board", () =>
  run(
    Effect.gen(function* () {
      const { pullRequests: resources, outside } = yield* setUp("Move the export", issue())
      yield* resources.register(session, issueRef, "owns")

      const quiet = yield* resources.observe(
        issue({ state: { name: "In Review", type: "started" }, comments: [{ id: "c1", author: "me" }] }),
      )

      expect(quiet).toEqual({ changes: ["StateChanged"], woke: 0 })

      const heard = yield* resources.observe(
        issue({
          state: { name: "In Review", type: "started" },
          comments: [
            { id: "c1", author: "me" },
            { id: "c2", author: "Jifeng" },
          ],
        }),
      )

      expect(heard).toEqual({ changes: ["Commented"], woke: 1 })
      const [wake] = yield* outside.wakes
      expect(wake?.text).toContain("Ratchet: Linear issue DX-1 changed.")
      expect(wake?.text).toContain("- Jifeng commented.")
    }),
  ))

test("one task at most owns a Linear issue, and a second one may still wait on it", () =>
  run(
    Effect.gen(function* () {
      const { pullRequests: resources, tasks } = yield* setUp("Move the export", issue())
      const other = SessionId.make("ses_2")

      yield* tasks.observe([
        SessionFact.cases.Opened.make({
          session: other,
          title: "Another",
          origin: SessionOrigin.cases.Root.make({}),
          running: false,
          subagents: [],
          questions: [],
        }),
      ])

      const owner = yield* resources.register(session, issueRef, "owns")
      const refused = yield* Effect.flip(resources.register(other, issueRef, "owns"))
      expect(refused).toBeInstanceOf(Resources.AlreadyOwned)
      expect(refused.message).toContain(owner.task)
      // The refused task follows nothing.
      expect((yield* resources.list(other)).resources).toEqual([])

      yield* resources.register(other, issueRef, "waits_on")
      const done = yield* resources.observe(issue({ state: { name: "Done", type: "completed" } }))
      expect(done).toEqual({ changes: ["Completed"], woke: 2 })
      expect((yield* resources.list(other)).resources).toMatchObject([{ label: "Linear issue DX-1", state: "Done", ended: "completed" }])
      // It has ended, so nothing reads it again.
      expect(yield* resources.watched).toEqual([])
    }),
  ))

const incidentRef = ResourceRef.cases.Incident.make({ number: 7 })

const incident = (over: Partial<IncidentFacts> = {}): ResourceFacts =>
  ResourceFacts.cases.Incident.make({
    facts: {
      ref: { number: 7 },
      name: "Checkout is down",
      url: "https://app.incident.io/lovable/incidents/7",
      status: { name: "Investigating", category: "live" },
      severity: "Major",
      ...over,
    },
  })

test("a task that waits on an incident hears only its end, and the board lists the incident with its status", () =>
  run(
    Effect.gen(function* () {
      const { pullRequests: resources, outside } = yield* setUp("Ship after the incident", incident())
      yield* resources.register(session, incidentRef, "waits_on")
      expect(yield* resources.watched).toEqual([incidentRef])

      const worse = yield* resources.observe(incident({ severity: "Critical", status: { name: "Fixing", category: "live" } }))
      expect(worse).toEqual({ changes: ["StatusChanged", "SeverityChanged"], woke: 0 })

      const rows = yield* Effect.flatMap(Index.Service, (index) => index.resources("all"))
      expect(rows).toMatchObject([
        { key: "incident:7", kind: "incident", state: "Fixing", title: "Checkout is down", detail: { severity: "Critical" } },
      ])

      const over = yield* resources.observe(incident({ status: { name: "Closed", category: "closed" } }))
      expect(over).toEqual({ changes: ["Ended"], woke: 1 })
      expect((yield* outside.wakes)[0]?.text).toContain("Ratchet: incident INC-7 changed.\n- It is over: Closed.")
    }),
  ))
