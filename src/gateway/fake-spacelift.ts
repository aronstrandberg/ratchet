import { Schema } from "effect"

/** A run as a test or a scratch Ratchet puts it into the stand-in. */
export const Run = Schema.Struct({
  id: Schema.String,
  stack: Schema.String,
  commit: Schema.String,
  /** `PROPOSED` for a plan on a pull request, `TRACKED` for a run on the branch. */
  type: Schema.Literals(["PROPOSED", "TRACKED"]),
  state: Schema.String,
  needsApproval: Schema.optional(Schema.Boolean),
  /** Unix seconds, as Spacelift gives them. */
  createdAt: Schema.optional(Schema.Number),
  updatedAt: Schema.optional(Schema.Number),
  delta: Schema.optional(Schema.Struct({ addCount: Schema.Int, changeCount: Schema.Int, deleteCount: Schema.Int })),
})

export type Run = typeof Run.Type

const Search = Schema.Struct({
  variables: Schema.Struct({
    input: Schema.Struct({
      predicates: Schema.Array(
        Schema.Struct({
          field: Schema.String,
          constraint: Schema.Struct({
            enumEquals: Schema.optional(Schema.Array(Schema.String)),
            stringEquals: Schema.optional(Schema.Array(Schema.String)),
          }),
        }),
      ),
    }),
  }),
})

const readSearch = Schema.decodeUnknownPromise(Search)

const fieldOf = (run: Run, field: string) => {
  switch (field) {
    case "type":
      return run.type
    case "stackSlug":
      return run.stack
    case "commit":
      return run.commit
    default:
      return ""
  }
}

/**
 * A stand-in for Spacelift's GraphQL API: the search for runs, over the runs `held` returns.
 *
 * Like Spacelift, it answers a request whose token it does not accept, with no viewer in the answer.
 * Whoever serves it says whether the token is good.
 */
export const make = (held: () => ReadonlyArray<Run>) => ({
  fetch: async (request: Request, accepted: boolean): Promise<Response> => {
    if (!accepted) return Response.json({ data: { viewer: null } })

    const { predicates } = (await readSearch(await request.json())).variables.input

    const found = held().filter((run) =>
      predicates.every(({ field, constraint }) => [...(constraint.enumEquals ?? []), ...(constraint.stringEquals ?? [])].includes(fieldOf(run, field))),
    )

    return Response.json({
      data: {
        viewer: { id: "me" },
        searchRuns: {
          edges: found.map((run) => ({
            node: {
              run: {
                id: run.id,
                state: run.state,
                needsApproval: run.needsApproval ?? false,
                createdAt: run.createdAt ?? 1_000,
                updatedAt: run.updatedAt ?? run.createdAt ?? 1_000,
                commit: { hash: run.commit },
                delta: run.delta ?? null,
              },
              stack: { id: run.stack },
            },
          })),
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    })
  },
})
