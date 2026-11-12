import { Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { OtlpSerialization, OtlpTracer } from "effect/observability"

/**
 * Exports spans over OTLP/HTTP to the collector at `OTLP_URL`. Without the variable, nothing is exported.
 */
export const layer = (env: { readonly OTLP_URL?: string }, serviceName: string): Layer.Layer<never> =>
  env.OTLP_URL === undefined || env.OTLP_URL === ""
    ? Layer.empty
    : OtlpTracer.layer({ url: `${env.OTLP_URL}/v1/traces`, resource: { serviceName } }).pipe(
        Layer.provide(OtlpSerialization.layerJson),
        Layer.provide(FetchHttpClient.layer),
      )
