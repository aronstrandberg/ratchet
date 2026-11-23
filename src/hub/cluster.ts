import { CloudflareCluster, CloudflareDurableObjects } from "@effect/platform-cloudflare"
import { Layer, ManagedRuntime, Result } from "effect"
import { EntityMachine } from "effect-machine/cluster"
import * as Config from "../config.ts"
import type { Env } from "../env.ts"
import * as Telemetry from "../telemetry.ts"
import * as Cells from "./cells.ts"
import * as GatewayBinding from "./gateway-binding.ts"
import { CommitBuildsEntity, commitBuildsMachine } from "./commit-builds.ts"
import { CommitRunsEntity, commitRunsMachine } from "./commit-runs.ts"
import { CoordinatorEntity, coordinatorMachine } from "./coordinator.ts"
import { DecisionEntity, decisionMachine } from "./decision.ts"
import * as Decisions from "./decisions.ts"
import { IncidentEntity, incidentMachine } from "./incident.ts"
import * as Index from "./index-store.ts"
import { LinearIssueEntity, linearIssueMachine } from "./linear-issue.ts"
import * as Persistence from "./persistence.ts"
import { PullRequestEntity, pullRequestMachine } from "./pull-request.ts"
import * as Resources from "./resources.ts"
import { SessionEntity, sessionMachine } from "./session.ts"
import { TaskEntity, taskMachine } from "./task.ts"
import * as Tasks from "./tasks.ts"
import * as WakePolicy from "./wake-policy.ts"
import * as Wakes from "./wakes.ts"

const journal = { persistence: { strategy: "journal" } } as const

/** The cells on the cluster: each machine as an entity, with its journal in its own Durable Object. */
const cells = (env: Env, config: Config.Hub) =>
  Layer.mergeAll(
    EntityMachine.layer(TaskEntity, taskMachine, journal),
    EntityMachine.layer(SessionEntity, sessionMachine, journal),
    EntityMachine.layer(PullRequestEntity, pullRequestMachine, journal),
    EntityMachine.layer(LinearIssueEntity, linearIssueMachine, journal),
    EntityMachine.layer(IncidentEntity, incidentMachine, journal),
    EntityMachine.layer(CommitBuildsEntity, commitBuildsMachine, journal),
    EntityMachine.layer(CommitRunsEntity, commitRunsMachine, journal),
    EntityMachine.layer(DecisionEntity, decisionMachine, journal),
    EntityMachine.layer(CoordinatorEntity, coordinatorMachine, journal),
  ).pipe(
    Layer.provide(
      Persistence.layerSqlite(
        {
          Task: Persistence.journaled(taskMachine),
          Session: Persistence.journaled(sessionMachine),
          PullRequest: Persistence.journaled(pullRequestMachine),
          LinearIssue: Persistence.journaled(linearIssueMachine),
          Incident: Persistence.journaled(incidentMachine),
          CommitBuilds: Persistence.journaled(commitBuildsMachine),
          CommitRuns: Persistence.journaled(commitRunsMachine),
          Decision: Persistence.journaled(decisionMachine),
          Coordinator: Persistence.journaled(coordinatorMachine),
        },
        CloudflareCluster.DurableObjectSqlClient.orDie,
      ),
    ),
    Layer.provideMerge(Telemetry.layer(config.tracing, "ratchet-hub")),
    Layer.provideMerge(
      CloudflareCluster.layer({
        entities: [TaskEntity, SessionEntity, PullRequestEntity, LinearIssueEntity, IncidentEntity, CommitBuildsEntity, CommitRunsEntity, DecisionEntity, CoordinatorEntity],
        entityNamespace: env.CLUSTER_ENTITY,
        workflowNamespace: env.CLUSTER_WORKFLOW,
        queueNamespace: env.CLUSTER_QUEUE,
        singletonNamespace: env.CLUSTER_SINGLETON,
      }),
    ),
  )

/** The hub: its application services on the cells, the D1 index and the gateway's binding. */
const layer = (env: Env, config: Config.Hub) =>
  Layer.mergeAll(Resources.layerWithoutDependencies, Decisions.layerWithoutDependencies).pipe(
    Layer.provideMerge(Layer.mergeAll(Tasks.layerWithoutDependencies, Wakes.layerWithoutDependencies)),
    Layer.provideMerge(Cells.layerWithoutDependencies),
    Layer.provideMerge(
      Layer.mergeAll(
        Index.layer(Index.d1(env.INDEX)),
        GatewayBinding.layer(env.GATEWAY),
        Layer.succeed(WakePolicy.Service, config.wake),
      ),
    ),
    Layer.provideMerge(cells(env, config)),
  )

/** What an effect may require when it runs on the hub's runtime. */
export type Services = Layer.Success<ReturnType<typeof layer>>

/** The hub's runtime in one isolate. */
export type Runtime = ManagedRuntime.ManagedRuntime<Services, never>

let application: Runtime | undefined

const build = async (env: Env): Promise<Runtime> => {
  if (application !== undefined) return application
  const config = Config.hub(env)

  // A setting the hub cannot start with fails every call, with a message that names the setting.
  if (Result.isFailure(config)) throw config.failure
  const runtime = ManagedRuntime.make(layer(env, config.success))
  await runtime.context().catch(async (error) => {
    await runtime.dispose()
    throw error
  })

  // A stalled build can finish after its replacement: keep the first one.
  if (application === undefined) {
    application = runtime

    return runtime
  }

  await runtime.dispose()

  return application
}

const initialize = CloudflareDurableObjects.setInitializer((env: Env) => build(env).then((runtime) => runtime.context()))

/** The hub's runtime in this isolate, built on first use by a Worker event or a Durable Object. */
export const runtime = async (env: Env): Promise<Runtime> => {
  await initialize(env)

  return build(env)
}
