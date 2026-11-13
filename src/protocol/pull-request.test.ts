import { expect, test } from "bun:test"
import { Option } from "effect"
import fc from "fast-check"
import { type PullRequestRef, keyOf, refOf } from "./pull-request.ts"

const name = fc.stringMatching(/^[A-Za-z0-9_.-]{1,30}$/)

const ref: fc.Arbitrary<PullRequestRef> = fc.record({
  owner: name,
  repo: name,
  number: fc.integer({ min: 1, max: 10_000_000 }),
})

test("a pull request's key names that pull request again, in lower case", () => {
  fc.assert(
    fc.property(ref, (pullRequest) => {
      expect(refOf(keyOf(pullRequest))).toEqual(
        Option.some({
          owner: pullRequest.owner.toLowerCase(),
          repo: pullRequest.repo.toLowerCase(),
          number: pullRequest.number,
        }),
      )
    }),
  )
})

test("two references that differ only in letter case have the same key", () => {
  fc.assert(
    fc.property(ref, (pullRequest) => {
      expect(keyOf({ ...pullRequest, owner: pullRequest.owner.toUpperCase() })).toBe(keyOf(pullRequest))
    }),
  )
})
