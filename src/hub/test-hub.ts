import { Database as Sqlite } from "bun:sqlite"
import { Context, Effect, Layer, Ref } from "effect"
import { TestRunner } from "effect/cluster"
import { EntityMachine } from "effect-machine/cluster"
import { SessionId, type TaskId } from "../protocol/ids.ts"
import { type PullRequestFacts, type PullRequestKey, keyOf } from "../protocol/pull-request.ts"
import type { Wake } from "../protocol/wake.ts"
import * as Cells from "./cells.ts"
import * as Index from "./index-store.ts"
import * as PullRequestSource from "./pull-request-source.ts"
import { PullRequestEntity, pullRequestMachine } from "./pull-request.ts"
import * as PullRequests from "./pull-requests.ts"
import * as SessionControl from "./session-control.ts"
import { SessionEntity, sessionMachine } from "./session.ts"
import { TaskEntity, taskMachine } from "./task.ts"
import * as Tasks from "./tasks.ts"
import * as WakePolicy from "./wake-policy.ts"

type Row = Readonly<Record<string, string | number | null>>

/** Runs the index's SQL on an SQLite database in memory: the same statements D1 runs. */
const sqlite = (): Index.Database => {
  const db = new Sqlite(":memory:")

  return {
    exec: async (statement) => {
      db.run(statement)
    },
    run: async (statement, values) => {
      db.query(statement).run(...values)
    },
    all: async (query) => db.query<Row, []>(query).all(),
  }
}

/** What a test sets up outside the hub, and what it reads back of what the hub did there. */
export interface Outside {
  /** Puts a pull request on GitHub, or replaces what GitHub holds for it. */
  readonly publish: (facts: PullRequestFacts) => Effect.Effect<void>
  /** Makes OpenCode refuse wake-ups, or take them again. */
  readonly refuseWakes: (refuse: boolean) => Effect.Effect<void>
  /** The wake-ups OpenCode took, in order. */
  readonly wakes: Effect.Effect<ReadonlyArray<Wake>>
  /** The tasks written into sessions' metadata, in order. */
  readonly recorded: Effect.Effect<ReadonlyArray<{ readonly session: SessionId; readonly task: TaskId }>>
}

/** The test's hold on GitHub and OpenCode. */
export class Control extends Context.Service<Control, Outside>()("@ratchet/hub/TestControl") {}

const outside = Layer.unwrap(
  Effect.gen(function* () {
    const github = yield* Ref.make(new Map<PullRequestKey, PullRequestFacts>())
    const refusing = yield* Ref.make(false)
    const wakes = yield* Ref.make<ReadonlyArray<Wake>>([])
    const recorded = yield* Ref.make<ReadonlyArray<{ readonly session: SessionId; readonly task: TaskId }>>([])
    let forks = 0

    const control = SessionControl.Service.of({
      recordTask: (session, task) => Ref.update(recorded, (all) => [...all, { session, task }]),
      fork: () => Effect.sync(() => SessionId.make(`ses_fork${++forks}`)),
      wake: (wake) =>
        Effect.flatMap(Ref.get(refusing), (refuse) =>
          refuse
            ? Effect.fail(
                new SessionControl.SessionControlFailed({ operation: "wake", session: wake.session, cause: "refused" }),
              )
            : Ref.update(wakes, (all) => [...all, wake]),
        ),
    })

    const source = PullRequestSource.Service.of({
      read: (ref) =>
        Effect.flatMap(Ref.get(github), (held) => {
          const facts = held.get(keyOf(ref))

          return facts === undefined
            ? Effect.fail(new PullRequestSource.PullRequestNotFound({ pullRequest: keyOf(ref) }))
            : Effect.succeed(facts)
        }),
    })

    return Layer.mergeAll(
      Layer.succeed(SessionControl.Service, control),
      Layer.succeed(PullRequestSource.Service, source),
      Layer.succeed(
        Control,
        Control.of({
          publish: (facts) => Ref.update(github, (held) => new Map(held).set(keyOf(facts.ref), facts)),
          refuseWakes: (refuse) => Ref.set(refusing, refuse),
          wakes: Ref.get(wakes),
          recorded: Ref.get(recorded),
        }),
      ),
    )
  }),
)

const cells = Layer.mergeAll(
  EntityMachine.layer(TaskEntity, taskMachine),
  EntityMachine.layer(SessionEntity, sessionMachine),
  EntityMachine.layer(PullRequestEntity, pullRequestMachine),
).pipe(Layer.provideMerge(TestRunner.layer))

/**
 * The hub as it runs in production, except for what is outside it: the cells run in memory, the index on
 * SQLite in memory, and GitHub and OpenCode are what `Control` makes them.
 */
export const layer = (wake: WakePolicy.WakePolicy = WakePolicy.WakePolicy.cases.Everybody.make({})) =>
  PullRequests.layerWithoutDependencies.pipe(
    Layer.provideMerge(Tasks.layerWithoutDependencies),
    Layer.provideMerge(Cells.layerWithoutDependencies),
    Layer.provideMerge(Layer.mergeAll(Index.layer(sqlite()), outside, Layer.succeed(WakePolicy.Service, wake))),
    Layer.provideMerge(cells),
  )

/** What a test of the hub may use. */
export type Services = Layer.Success<ReturnType<typeof layer>>
