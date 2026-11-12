import { Effect } from "effect"
import type { Env } from "./env.ts"
import { runtime } from "./hub/cluster.ts"
import { TaskEntity, TaskEvent } from "./hub/task.ts"

export {
  ClusterDurableQueue,
  ClusterEntity,
  ClusterSingleton,
  ClusterWorkflow,
} from "@effect/platform-cloudflare/CloudflareDurableObjects"

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const [, id, action] = url.pathname.split("/")
    if (id === undefined || id === "") return new Response("task id required\n", { status: 400 })
    const app = await runtime(env)
    const program = Effect.gen(function* () {
      const task = (yield* TaskEntity.client)(id)
      switch (action) {
        case "create":
          return yield* task.Send({
            event: TaskEvent.Created({ title: `Task ${id}`, parent: null, session: `ses_${id}` }),
          })
        case "start":
          return yield* task.Send({ event: TaskEvent.SessionStarted({ session: `ses_${id}` }) })
        case "idle":
          return yield* task.Send({ event: TaskEvent.SessionIdle({ session: `ses_${id}` }) })
        default:
          return yield* task.GetState()
      }
    })
    return Response.json(await app.runPromise(program))
  },
}
