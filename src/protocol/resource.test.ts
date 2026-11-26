import { expect, test } from "bun:test"
import { Option } from "effect"
import fc from "fast-check"
import { ResourceRef, keyOf, parseReference, refOf } from "./resource.ts"

const name = fc.stringMatching(/^[A-Za-z0-9_.-]{1,30}$/)
const number = fc.integer({ min: 1, max: 10_000_000 })

const ref: fc.Arbitrary<ResourceRef> = fc.oneof(
  fc.record({ owner: name, repo: name, number }).map((fields) => ResourceRef.cases.PullRequest.make(fields)),
  fc
    .record({ team: fc.stringMatching(/^[A-Z][A-Z0-9]{0,6}$/), number })
    .map(({ team, number }) => ResourceRef.cases.LinearIssue.make({ identifier: `${team}-${number}` })),
  number.map((number) => ResourceRef.cases.Incident.make({ number })),
  fc
    .record({ owner: name, repo: name, commit: fc.stringMatching(/^[0-9a-f]{40}$/) })
    .map((fields) => ResourceRef.cases.CommitBuilds.make(fields)),
  fc
    .record({ owner: name, repo: name, commit: fc.stringMatching(/^[0-9a-f]{40}$/) })
    .map((fields) => ResourceRef.cases.CommitRuns.make(fields)),
  fc
    .option(fc.stringMatching(/^[a-z0-9][a-z0-9_.-]{0,20}$/).filter((team) => team !== "all"), { nil: null })
    .map((team) => ResourceRef.cases.AlertFeed.make({ team })),
)

/** A reference as its key spells it: a pull request's owner and repository in lower case. */
const canonical = (resource: ResourceRef): ResourceRef =>
  ResourceRef.match(resource, {
    PullRequest: ({ owner, repo, number }) =>
      ResourceRef.cases.PullRequest.make({ owner: owner.toLowerCase(), repo: repo.toLowerCase(), number }),
    LinearIssue: (issue) => issue,
    Incident: (incident) => incident,
    CommitBuilds: ({ owner, repo, commit }) =>
      ResourceRef.cases.CommitBuilds.make({ owner: owner.toLowerCase(), repo: repo.toLowerCase(), commit }),
    CommitRuns: ({ owner, repo, commit }) =>
      ResourceRef.cases.CommitRuns.make({ owner: owner.toLowerCase(), repo: repo.toLowerCase(), commit }),
    AlertFeed: (feed) => feed,
  })

test("a resource's key names that resource again", () => {
  fc.assert(
    fc.property(ref, (resource) => {
      expect(refOf(keyOf(resource))).toEqual(Option.some(canonical(resource)))
    }),
  )
})

test("a resource is read from its address in a browser and from its short name", () => {
  const pullRequest = Option.some(ResourceRef.cases.PullRequest.make({ owner: "lovablelabs", repo: "lovable", number: 12 }))
  const issue = Option.some(ResourceRef.cases.LinearIssue.make({ identifier: "DX-1550" }))
  const incident = Option.some(ResourceRef.cases.Incident.make({ number: 123 }))

  expect(parseReference("https://github.com/lovablelabs/lovable/pull/12/files")).toEqual(pullRequest)
  expect(parseReference("lovablelabs/lovable#12")).toEqual(pullRequest)
  expect(parseReference("https://linear.app/lovable/issue/DX-1550/move-otlp-export")).toEqual(issue)
  expect(parseReference(" dx-1550 ")).toEqual(issue)
  expect(parseReference("https://app.incident.io/lovable/incidents/123")).toEqual(incident)
  // INC is incident.io's prefix, so it is never read as a Linear team.
  expect(parseReference("INC-123")).toEqual(incident)
  // The key the tools answer with is read back as the resource it names.
  expect(parseReference("linear:dx-1550")).toEqual(issue)
  expect(parseReference("incident:123")).toEqual(incident)
  expect(parseReference(`builds:lovablelabs/lovable@${"ab12".repeat(10)}`)).toEqual(
    Option.some(ResourceRef.cases.CommitBuilds.make({ owner: "lovablelabs", repo: "lovable", commit: "ab12".repeat(10) })),
  )
  expect(parseReference("https://example.com/DX-1550")).toEqual(Option.none())
})
