import { CloudflareCluster, CloudflareDurableObjects } from "@effect/platform-cloudflare"
import { Layer, ManagedRuntime } from "effect"
import { EntityMachine } from "effect-machine/cluster"
import type { Env } from "../env.ts"
import * as Persistence from "./persistence.ts"
import { TaskEntity, taskMachine } from "./task.ts"

const TaskLayer = EntityMachine.layer(TaskEntity, taskMachine, { persistence: { strategy: "journal" } })

const layer = (env: Env) =>
  TaskLayer.pipe(
    Layer.provide(Persistence.layerSqlite({ Task: { state: taskMachine.stateSchema, event: taskMachine.eventSchema } })),
    Layer.provideMerge(
      CloudflareCluster.layer({
        entities: [TaskEntity],
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
