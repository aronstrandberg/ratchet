import type * as Index from "./index-store.ts"

/** An index that keeps nothing, for tests that only read the cells. */
export const noIndex: Index.Database = {
  exec: async () => {},
  run: async () => {},
  all: async () => [],
}
