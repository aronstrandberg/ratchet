import { CloudflareCluster, CloudflareDurableObjects } from "@effect/platform-cloudflare"
import { Layer, ManagedRuntime } from "effect"
import { EntityMachine } from "effect-machine/cluster"
import type { Env } from "../env.ts"
import * as Telemetry from "../telemetry.ts"
import * as Persistence from "./persistence.ts"
import { PullRequestEntity, pullRequestMachine } from "./pull-request.ts"
import { SessionEntity, sessionMachine } from "./session.ts"
import { TaskEntity, taskMachine } from "./task.ts"

const journal = { persistence: { strategy: "journal" } } as const

const layer = (env: Env) =>
  Layer.mergeAll(
    EntityMachine.layer(TaskEntity, taskMachine, journal),
    EntityMachine.layer(SessionEntity, sessionMachine, journal),
    EntityMachine.layer(PullRequestEntity, pullRequestMachine, journal),
  ).pipe(
    Layer.provide(
      Persistence.layerSqlite(
        {
          Task: Persistence.journaled(taskMachine),
          Session: Persistence.journaled(sessionMachine),
          PullRequest: Persistence.journaled(pullRequestMachine),
        },
        CloudflareCluster.DurableObjectSqlClient.orDie,
      ),
    ),
    Layer.provideMerge(Telemetry.layer(env, "ratchet-hub")),
    Layer.provideMerge(
      CloudflareCluster.layer({
        entities: [TaskEntity, SessionEntity, PullRequestEntity],
        entityNamespace: env.CLUSTER_ENTITY,
        workflowNamespace: env.CLUSTER_WORKFLOW,
        queueNamespace: env.CLUSTER_QUEUE,
        singletonNamespace: env.CLUSTER_SINGLETON,
      }),
    ),
  )

export type Runtime = ManagedRuntime.ManagedRuntime<Layer.Success<ReturnType<typeof layer>>, never>

let application: Runtime | undefined

const build = async (env: Env): Promise<Runtime> => {
  if (application !== undefined) return application
  const runtime = ManagedRuntime.make(layer(env))
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

/** The cluster runtime of this isolate, built on first use by a Worker event or a Durable Object. */
export const runtime = async (env: Env): Promise<Runtime> => {
  await initialize(env)
  return build(env)
}
