import { Layer, Option } from "effect"
import { FetchHttpClient } from "effect/http"
import { OtlpSerialization, OtlpTracer } from "effect/observability"
import type { Tracing } from "./config.ts"

/** Exports spans over OTLP/HTTP to the collector, under `serviceName`. Without a collector nothing is exported. */
export const layer = (tracing: Tracing, serviceName: string): Layer.Layer<never> =>
  Option.match(tracing, {
    onNone: () => Layer.empty,
    onSome: ({ url }) =>
      OtlpTracer.layer({ url: `${url}/v1/traces`, resource: { serviceName } }).pipe(
        Layer.provide(OtlpSerialization.layerJson),
        Layer.provide(FetchHttpClient.layer),
      ),
  })
