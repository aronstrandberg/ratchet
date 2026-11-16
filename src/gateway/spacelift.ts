import { Context, Effect, Layer, Redacted, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { causeText } from "../failure.ts"
import * as SignIns from "./sign-ins.ts"

/** Spacelift did not answer, refused the request, or answered with something this adapter cannot read. */
export class SpaceliftUnavailable extends Schema.TaggedError<SpaceliftUnavailable>()("SpaceliftUnavailable", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Spacelift failed (${this.operation}): ${causeText(this.cause)}`
  }
}

/** Where the Spacelift account is, such as `https://lovable.app.spacelift.io`. */
export interface Config {
  readonly url: string
}

/** A run as Spacelift lists it, with the stack it belongs to. */
export interface Listed {
  readonly id: string
  readonly stack: string
  /** Spacelift's word for where the run stands, such as `UNCONFIRMED`, `FINISHED`, `FAILED` or `SKIPPED`. */
  readonly state: string
  readonly needsApproval: boolean
  /** Where a person opens the run. */
  readonly url: string
  /** The commit the run was started for. */
  readonly commit: string
  /** When the run was created and when it last changed, in milliseconds since the epoch. */
  readonly createdAt: number
  readonly updatedAt: number
  /** How many resources the run's plan adds, changes and deletes, or null before it has planned. */
  readonly delta: { readonly add: number; readonly change: number; readonly delete: number } | null
}

type Failure = SpaceliftUnavailable | SignIns.NotSignedIn

/** Spacelift's runs, as the gateway reads them. */
export interface Interface {
  /** The stacks that planned any of the commits given: those with a proposed run for one of them. */
  readonly planned: (commits: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<string>, Failure>
  /** The tracked runs of the stacks given that were started for any of the commits given. */
  readonly tracked: (stacks: ReadonlyArray<string>, commits: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<Listed>, Failure>
}

/** The gateway's connection to Spacelift. */
export class Service extends Context.Service<Service, Interface>()("@ratchet/gateway/Spacelift") {}

const query = `query($input: SearchInput!) {
  viewer { id }
  searchRuns(input: $input) {
    edges { node {
      run {
        id state needsApproval createdAt updatedAt
        commit { hash }
        delta { addCount changeCount deleteCount }
      }
      stack { id }
    } }
    pageInfo { hasNextPage endCursor }
  }
}`

const Answer = Schema.Struct({
  errors: Schema.optional(Schema.Array(Schema.Struct({ message: Schema.String }))),
  data: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        /** Null when Spacelift does not accept the token: it answers such a request, with nothing in it. */
        viewer: Schema.optional(Schema.NullOr(Schema.Struct({ id: Schema.String }))),
        searchRuns: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              edges: Schema.Array(
                Schema.Struct({
                  node: Schema.Struct({
                    run: Schema.Struct({
                      id: Schema.String,
                      state: Schema.String,
                      needsApproval: Schema.Boolean,
                      createdAt: Schema.Number,
                      updatedAt: Schema.Number,
                      commit: Schema.Struct({ hash: Schema.String }),
                      delta: Schema.optional(
                        Schema.NullOr(
                          Schema.Struct({ addCount: Schema.Int, changeCount: Schema.Int, deleteCount: Schema.Int }),
                        ),
                      ),
                    }),
                    stack: Schema.Struct({ id: Schema.String }),
                  }),
                }),
              ),
              pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean, endCursor: Schema.optional(Schema.NullOr(Schema.String)) }),
            }),
          ),
        ),
      }),
    ),
  ),
})

/** One condition of a search: a field that equals one of the values given. */
interface Predicate {
  readonly field: string
  readonly exclude: false
  readonly constraint: { readonly enumEquals: ReadonlyArray<string> } | { readonly stringEquals: ReadonlyArray<string> }
}

const ofType = (type: "PROPOSED" | "TRACKED"): Predicate => ({ field: "type", exclude: false, constraint: { enumEquals: [type] } })
const among = (field: string, values: ReadonlyArray<string>): Predicate => ({ field, exclude: false, constraint: { stringEquals: values } })

/** The most pages of runs that one search takes: a hundred runs each. */
const pages = 10

/** Builds the connection on an HTTP client and the gateway's sign-ins. Nothing is sent until a read runs. */
export const make = (config: Config): Effect.Effect<Interface, never, HttpClient.HttpClient | SignIns.Service> =>
  Effect.gen(function* () {
    const http = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
    const signIns = yield* SignIns.Service
    const unavailable = (operation: string) => (cause: unknown) => new SpaceliftUnavailable({ operation, cause })

    const post = (operation: string, predicates: ReadonlyArray<Predicate>, after: string | null) =>
      Effect.gen(function* () {
        const token = yield* signIns.token("spacelift").pipe(Effect.catchTag("SignInFailed", (failure) => Effect.fail(unavailable(operation)(failure))))

        const answer = yield* HttpClientRequest.post(`${config.url}/graphql`).pipe(
          HttpClientRequest.bearerToken(Redacted.value(token)),
          HttpClientRequest.bodyJsonUnsafe({ query, variables: { input: { first: 100, after, predicates } } }),
          http.execute,
          Effect.flatMap(HttpClientResponse.schemaBodyJson(Answer)),
          Effect.mapError(unavailable(operation)),
        )

        return { answer, token }
      })

    /** One page of a search. A token that Spacelift does not accept is marked as used up, and the page is asked for once more. */
    const page = (operation: string, predicates: ReadonlyArray<Predicate>, after: string | null) =>
      Effect.gen(function* () {
        const first = yield* post(operation, predicates, after)

        if (first.answer.data?.viewer !== null && first.answer.data?.viewer !== undefined) return first.answer

        yield* signIns.expire("spacelift", first.token).pipe(Effect.mapError(unavailable(operation)))
        const second = yield* post(operation, predicates, after)

        return second.answer.data?.viewer === null || second.answer.data?.viewer === undefined
          ? yield* new SpaceliftUnavailable({ operation, cause: "Spacelift did not accept the sign-in's token" })
          : second.answer
      })

    const search = Effect.fnUntraced(function* (operation: string, predicates: ReadonlyArray<Predicate>) {
      const found: Array<Listed> = []
      let after: string | null = null

      for (let turn = 0; turn < pages; turn++) {
        const answer: typeof Answer.Type = yield* page(operation, predicates, after)
        const runs = answer.data?.searchRuns

        if (runs === null || runs === undefined) {
          const problem = (answer.errors ?? []).map((error) => error.message).join("; ")

          return yield* new SpaceliftUnavailable({ operation, cause: problem === "" ? "the answer holds no runs" : problem })
        }

        for (const { node } of runs.edges) {
          const delta = node.run.delta ?? null

          found.push({
            id: node.run.id,
            stack: node.stack.id,
            state: node.run.state,
            needsApproval: node.run.needsApproval,
            url: `${config.url}/stack/${node.stack.id}/run/${node.run.id}`,
            commit: node.run.commit.hash,
            createdAt: node.run.createdAt * 1000,
            updatedAt: node.run.updatedAt * 1000,
            delta: delta === null ? null : { add: delta.addCount, change: delta.changeCount, delete: delta.deleteCount },
          })
        }

        after = runs.pageInfo.endCursor ?? null

        if (!runs.pageInfo.hasNextPage || after === null) break
      }

      return found
    })

    const planned = Effect.fn("Spacelift.planned")(function* (commits: ReadonlyArray<string>) {
      if (commits.length === 0) return []
      const runs = yield* search("planned", [ofType("PROPOSED"), among("commit", commits)])

      return [...new Set(runs.map((run) => run.stack))].toSorted()
    })

    const tracked = Effect.fn("Spacelift.tracked")(function* (stacks: ReadonlyArray<string>, commits: ReadonlyArray<string>) {
      if (stacks.length === 0 || commits.length === 0) return []

      return yield* search("tracked", [ofType("TRACKED"), among("stackSlug", stacks), among("commit", commits)])
    })

    return Service.of({ planned, tracked })
  })

/** The connection to Spacelift, still in need of an HTTP client and the gateway's sign-ins. */
export const layerWithoutDependencies = (
  config: Config,
): Layer.Layer<Service, never, HttpClient.HttpClient | SignIns.Service> => Layer.effect(Service, make(config))

/** The connection to Spacelift over `fetch`, still in need of the gateway's sign-ins. */
export const layer = (config: Config): Layer.Layer<Service, never, SignIns.Service> =>
  layerWithoutDependencies(config).pipe(Layer.provide(FetchHttpClient.layer))
