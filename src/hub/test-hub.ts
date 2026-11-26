import { Database as Sqlite } from "bun:sqlite"
import { Context, Effect, Layer, Ref } from "effect"
import { TestRunner } from "effect/cluster"
import { EntityMachine } from "effect-machine/cluster"
import { SessionId, type TaskId } from "../protocol/ids.ts"
import { type ResourceFacts, type ResourceKey, keyOf, subjectOf } from "../protocol/resource.ts"
import type { Wake } from "../protocol/wake.ts"
import * as Cells from "./cells.ts"
import { CommitBuildsEntity, commitBuildsMachine } from "./commit-builds.ts"
import { CommitRunsEntity, commitRunsMachine } from "./commit-runs.ts"
import { AlertFeedEntity, alertFeedMachine } from "./alert-feed.ts"
import { CoordinatorEntity, coordinatorMachine } from "./coordinator.ts"
import { DecisionEntity, decisionMachine } from "./decision.ts"
import * as Decisions from "./decisions.ts"
import { IncidentEntity, incidentMachine } from "./incident.ts"
import * as Index from "./index-store.ts"
import { LinearIssueEntity, linearIssueMachine } from "./linear-issue.ts"
import { PullRequestEntity, pullRequestMachine } from "./pull-request.ts"
import * as ResourceSource from "./resource-source.ts"
import * as Resources from "./resources.ts"
import * as SessionControl from "./session-control.ts"
import { SessionEntity, sessionMachine } from "./session.ts"
import { TaskEntity, taskMachine } from "./task.ts"
import * as Tasks from "./tasks.ts"
import * as WakePolicy from "./wake-policy.ts"
import * as Wakes from "./wakes.ts"

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
  /** Puts a resource into its own system, or replaces what that system holds for it. */
  readonly publish: (observed: ResourceFacts) => Effect.Effect<void>
  /** Makes OpenCode refuse wake-ups, or take them again. */
  readonly refuseWakes: (refuse: boolean) => Effect.Effect<void>
  /** The wake-ups OpenCode took, in order. */
  readonly wakes: Effect.Effect<ReadonlyArray<Wake>>
  /** The tasks written into sessions' metadata, in order. */
  readonly recorded: Effect.Effect<ReadonlyArray<{ readonly session: SessionId; readonly task: TaskId }>>
}

/** The test's hold on OpenCode and on the systems resources live in. */
export class Control extends Context.Service<Control, Outside>()("@ratchet/hub/TestControl") {}

const outside = Layer.unwrap(
  Effect.gen(function* () {
    const systems = yield* Ref.make(new Map<ResourceKey, ResourceFacts>())
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

    const source = ResourceSource.Service.of({
      read: (ref) =>
        Effect.flatMap(Ref.get(systems), (held) => {
          const observed = held.get(keyOf(ref))

          return observed === undefined
            ? Effect.fail(new ResourceSource.ResourceNotFound({ resource: keyOf(ref) }))
            : Effect.succeed(observed)
        }),
    })

    return Layer.mergeAll(
      Layer.succeed(SessionControl.Service, control),
      Layer.succeed(ResourceSource.Service, source),
      Layer.succeed(
        Control,
        Control.of({
          publish: (observed) => Ref.update(systems, (held) => new Map(held).set(keyOf(subjectOf(observed)), observed)),
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
  EntityMachine.layer(LinearIssueEntity, linearIssueMachine),
  EntityMachine.layer(IncidentEntity, incidentMachine),
  EntityMachine.layer(CommitBuildsEntity, commitBuildsMachine),
  EntityMachine.layer(CommitRunsEntity, commitRunsMachine),
  EntityMachine.layer(DecisionEntity, decisionMachine),
  EntityMachine.layer(CoordinatorEntity, coordinatorMachine),
  EntityMachine.layer(AlertFeedEntity, alertFeedMachine),
).pipe(Layer.provideMerge(TestRunner.layer))

/**
 * The hub as it runs in production, except for what is outside it: the cells run in memory, the index on
 * SQLite in memory, and OpenCode, GitHub, Linear and incident.io are what `Control` makes them.
 */
export const layer = (wake: WakePolicy.WakePolicy = WakePolicy.WakePolicy.cases.Everybody.make({})) =>
  Layer.mergeAll(Resources.layerWithoutDependencies, Decisions.layerWithoutDependencies).pipe(
    Layer.provideMerge(Layer.mergeAll(Tasks.layerWithoutDependencies, Wakes.layerWithoutDependencies)),
    Layer.provideMerge(Cells.layerWithoutDependencies),
    Layer.provideMerge(Layer.mergeAll(Index.layer(sqlite()), outside, Layer.succeed(WakePolicy.Service, wake))),
    Layer.provideMerge(cells),
  )

/** What a test of the hub may use. */
export type Services = Layer.Success<ReturnType<typeof layer>>
