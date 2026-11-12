export interface Env {
  readonly CLUSTER_ENTITY: DurableObjectNamespace
  readonly CLUSTER_WORKFLOW: DurableObjectNamespace
  readonly CLUSTER_QUEUE: DurableObjectNamespace
  readonly CLUSTER_SINGLETON: DurableObjectNamespace
}
