import { expect, test } from "bun:test"
import { Effect, Layer, Queue, Ref, Stream } from "effect"
import type { PullRequestFacts } from "../protocol/pull-request.ts"
import { ResourceRef, keyOf, subjectOf } from "../protocol/resource.ts"
import * as CommitBuilds from "./commit-builds.ts"
import * as CommitRuns from "./commit-runs.ts"
import * as GitHub from "./github.ts"
import * as HubReports from "./hub-reports.ts"
import * as IncidentIo from "./incident-io.ts"
import * as Linear from "./linear.ts"
import * as LiveReads from "./live-reads.ts"
import * as WebhookProxy from "./webhook-proxy.ts"

const pullRequest = (number: number) => ResourceRef.cases.PullRequest.make({ owner: "lovablelabs", repo: "lovable", number })

const event = (id: string, numbers: ReadonlyArray<number>, conclusion: string | null = null) =>
  WebhookProxy.Frame.cases.Event.make({
    id,
    type: conclusion === null ? "issue_comment" : "check_run",
    action: null,
    conclusion,
    repo: "lovablelabs/lovable",
    pullRequests: numbers,
  })

/**
 * What is outside the listening, as a test holds it: the pull requests the hub watches, the frames the proxy
 * sends, the scopes each connection asked for, and the pull requests that were read and reported.
 */
const outside = Effect.gen(function* () {
  const watched = yield* Ref.make<ReadonlyArray<ResourceRef>>([pullRequest(1), pullRequest(2)])
  const frames = yield* Queue.unbounded<WebhookProxy.Frame>()
  const connections = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([])
  const reported = yield* Ref.make<ReadonlyArray<string>>([])

  const facts = (ref: PullRequestFacts["ref"]): PullRequestFacts => ({
    ref,
    title: "A change",
    state: "open",
    draft: false,
    head: "aaa",
    mergeCommit: null,
    mergeable: "mergeable",
    reviewDecision: null,
    queued: false,
    checks: [],
    threads: [],
    reviews: [],
    viewer: "me",
  })

  const unused = () => Effect.die("this test reads pull requests only")

  const layer = Layer.mergeAll(
    Layer.succeed(
      WebhookProxy.Service,
      WebhookProxy.Service.of({
        frames: (scopes) => Stream.unwrap(Effect.as(Ref.update(connections, (all) => [...all, scopes]), Stream.fromQueue(frames))),
      }),
    ),
    Layer.succeed(
      HubReports.Service,
      HubReports.Service.of({
        sessionFacts: () => Effect.succeed([]),
        resourceFacts: (observed) => Ref.update(reported, (all) => [...all, keyOf(subjectOf(observed))]),
        watchedResources: Ref.get(watched),
        deliverWakes: Effect.void,
      }),
    ),
    Layer.succeed(GitHub.Service, GitHub.Service.of({ read: (ref) => Effect.succeed(facts(ref)), landing: unused })),
    Layer.succeed(Linear.Service, Linear.Service.of({ read: unused })),
    Layer.succeed(IncidentIo.Service, IncidentIo.Service.of({ read: unused })),
    Layer.succeed(CommitBuilds.Service, CommitBuilds.Service.of({ read: unused })),
    Layer.succeed(CommitRuns.Service, CommitRuns.Service.of({ read: unused })),
  )

  return { watched, frames, connections, reported, layer }
})

/** Runs the listening while `act` runs against it, and answers what `act` answers. */
const listening = <A>(act: (held: Effect.Success<typeof outside>, status: Ref.Ref<LiveReads.Status>) => Effect.Effect<A>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const held = yield* outside
      const status = yield* Ref.make(LiveReads.idle)
      const config = { repos: ["lovablelabs/lovable"], prompt: 0, relaxed: "1 minute", recheck: "50 millis" } as const
      const running = LiveReads.run(status, config).pipe(Effect.provide(held.layer))

      return yield* Effect.raceFirst(running, act(held, status))
    }),
  )

/** Long enough for the reading to come round, which it does every second. */
const settle = Effect.sleep("1500 millis")

test("a frame has its pull request read and reported once, however often it comes, and a passed check waits", async () => {
  const [reported, status] = await listening((held, status) =>
    Effect.gen(function* () {
      yield* Queue.offerAll(held.frames, [
        WebhookProxy.Frame.cases.Heartbeat.make({ cursor: null }),
        event("f1", [1]),
        event("f1", [1]),
        event("f2", [1]),
        // A pull request nobody watches, and a check that passed on one that is watched.
        event("f3", [7]),
        event("f4", [2], "success"),
      ])
      yield* settle

      return [yield* Ref.get(held.reported), yield* Ref.get(status)] as const
    }),
  )

  expect(reported).toEqual(["lovablelabs/lovable#1"])
  expect(status).toEqual({ covered: ["lovablelabs/lovable#1", "lovablelabs/lovable#2"], frames: 4, reads: 1, problem: null })
})

test("a gap has every pull request of the stream read, because the proxy does not say whose events were missed", async () => {
  const reported = await listening((held) =>
    Effect.gen(function* () {
      yield* Queue.offer(held.frames, WebhookProxy.Frame.cases.Gap.make({}))
      yield* settle

      return yield* Ref.get(held.reported)
    }),
  )

  expect(reported.toSorted()).toEqual(["lovablelabs/lovable#1", "lovablelabs/lovable#2"])
})

test("when the hub watches another pull request, the stream is opened again with it, and only for the proxy's repositories", async () => {
  const connections = await listening((held) =>
    Effect.gen(function* () {
      yield* Effect.sleep("100 millis")
      yield* Ref.set(held.watched, [
        pullRequest(2),
        pullRequest(3),
        ResourceRef.cases.PullRequest.make({ owner: "aronstrandberg", repo: "ratchet", number: 4 }),
        ResourceRef.cases.LinearIssue.make({ identifier: "DX-1" }),
      ])
      yield* Effect.sleep("300 millis")

      return yield* Ref.get(held.connections)
    }),
  )

  expect(connections).toEqual([
    ["lovablelabs/lovable#1", "lovablelabs/lovable#2"],
    ["lovablelabs/lovable#2", "lovablelabs/lovable#3"],
  ])
})
