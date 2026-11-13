import { Option, Schema } from "effect"
import { IncidentFacts, IncidentRef } from "./incident.ts"
import { LinearIssueFacts, LinearIssueRef } from "./linear.ts"
import { PullRequestFacts, PullRequestRef } from "./pull-request.ts"

/** Something outside OpenCode that a task can follow, as its own system addresses it. */
export const ResourceRef = Schema.TaggedUnion({
  PullRequest: PullRequestRef.fields,
  LinearIssue: LinearIssueRef.fields,
  Incident: IncidentRef.fields,
})

export type ResourceRef = typeof ResourceRef.Type

/**
 * The name a resource is known by across the hub, in lower case: `owner/repo#number` for a pull request,
 * `linear:dx-1550` for a Linear issue, `incident:123` for an incident.
 */
export const ResourceKey = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^([a-z0-9_.-]+\/[a-z0-9_.-]+#[1-9][0-9]*|linear:[a-z][a-z0-9]*-[1-9][0-9]*|incident:[1-9][0-9]*)$/)),
  Schema.brand("ResourceKey"),
)

export type ResourceKey = typeof ResourceKey.Type

/** The key of a resource. Two references that differ only in letter case have the same key. */
export const keyOf = (ref: ResourceRef): ResourceKey =>
  ResourceKey.make(
    ResourceRef.match(ref, {
      PullRequest: ({ owner, repo, number }) => `${owner}/${repo}#${number}`.toLowerCase(),
      LinearIssue: ({ identifier }) => `linear:${identifier.toLowerCase()}`,
      Incident: ({ number }) => `incident:${number}`,
    }),
  )

const parsePullRequest = Schema.decodeUnknownOption(PullRequestRef)
const parseLinearIssue = Schema.decodeUnknownOption(LinearIssueRef)
const parseIncident = Schema.decodeUnknownOption(IncidentRef)

const pullRequest = (owner: string | undefined, repo: string | undefined, number: string | undefined) =>
  Option.map(parsePullRequest({ owner, repo, number: Number(number) }), (ref) => ResourceRef.cases.PullRequest.make(ref))

const linearIssue = (identifier: string | undefined) =>
  Option.map(parseLinearIssue({ identifier: identifier?.toUpperCase() }), (ref) => ResourceRef.cases.LinearIssue.make(ref))

const incident = (number: string | undefined) =>
  Option.map(parseIncident({ number: Number(number) }), (ref) => ResourceRef.cases.Incident.make(ref))

/** The resource a key names. */
export const refOf = (key: ResourceKey): Option.Option<ResourceRef> => {
  if (key.startsWith("linear:")) return linearIssue(key.slice("linear:".length))

  if (key.startsWith("incident:")) return incident(key.slice("incident:".length))

  const [repository, number] = key.split("#")
  const [owner, repo] = (repository ?? "").split("/")

  return pullRequest(owner, repo, number)
}

/** What a resource is called in a sentence, such as `pull request o/r#1` or `Linear issue DX-1550`. */
export const labelOf = (ref: ResourceRef): string =>
  ResourceRef.match(ref, {
    PullRequest: ({ owner, repo, number }) => `pull request ${owner}/${repo}#${number}`,
    LinearIssue: ({ identifier }) => `Linear issue ${identifier}`,
    Incident: ({ number }) => `incident INC-${number}`,
  })

const shorthand = [
  // A pull request: its address on GitHub, or owner/repo#number.
  { pattern: /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/, kind: "PullRequest" },
  { pattern: /^([\w.-]+)\/([\w.-]+)#(\d+)$/, kind: "PullRequest" },
  // An incident: its address on incident.io, or INC-number. `INC` is therefore never read as a Linear team.
  { pattern: /^https:\/\/app\.incident\.io\/[\w.-]+\/incidents\/(\d+)(?:[/?#].*)?$/, kind: "Incident" },
  { pattern: /^INC-(\d+)$/i, kind: "Incident" },
  // A Linear issue: its address on Linear, or its identifier.
  { pattern: /^https:\/\/linear\.app\/[\w.-]+\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)(?:[/?#].*)?$/, kind: "LinearIssue" },
  { pattern: /^([A-Za-z][A-Za-z0-9]*-\d+)$/, kind: "LinearIssue" },
] as const

/**
 * Reads a resource from what a person or a session would write for it: its address in a browser, or its
 * short name, such as `owner/repo#12`, `DX-1550` or `INC-123`.
 */
export const parseReference = (text: string): Option.Option<ResourceRef> => {
  for (const { pattern, kind } of shorthand) {
    const match = pattern.exec(text.trim())

    if (match === null) continue
    const [, first, second, third] = match

    switch (kind) {
      case "PullRequest":
        return pullRequest(first, second, third)
      case "Incident":
        return incident(first)
      case "LinearIssue":
        return linearIssue(first)
    }
  }

  return Option.none()
}

/**
 * What a resource is to a task. `owns`: the task is the work on it, and its session drives it. `waits_on`:
 * the task needs it done and does not work on it. `context`: related, and nothing about it should wake anyone.
 */
export const Relation = Schema.Literals(["owns", "waits_on", "context"])

export type Relation = typeof Relation.Type

/** What a session says about its own work on a resource. */
export const WorkStatus = Schema.Literals(["unassigned", "agent-working", "waiting-ci", "waiting-user", "blocked", "ready"])

export type WorkStatus = typeof WorkStatus.Type

/** How a resource ended. Nothing more happens to it after that. */
export const Outcome = Schema.Literals(["merged", "closed", "completed", "canceled", "declined"])

export type Outcome = typeof Outcome.Type

/** A resource as its system holds it at one moment: an observation, with no judgement in it. */
export const ResourceFacts = Schema.TaggedUnion({
  PullRequest: { facts: PullRequestFacts },
  LinearIssue: { facts: LinearIssueFacts },
  Incident: { facts: IncidentFacts },
})

export type ResourceFacts = typeof ResourceFacts.Type

/** The resource an observation is of. */
export const subjectOf = (observed: ResourceFacts): ResourceRef =>
  ResourceFacts.match(observed, {
    PullRequest: ({ facts }) => ResourceRef.cases.PullRequest.make(facts.ref),
    LinearIssue: ({ facts }) => ResourceRef.cases.LinearIssue.make(facts.ref),
    Incident: ({ facts }) => ResourceRef.cases.Incident.make(facts.ref),
  })

/**
 * What a read of a resource answers, as it crosses from the gateway to the hub.
 *
 * A failed read is a value here, because the hub acts on which failure it was.
 */
export const ReadReply = Schema.TaggedUnion({
  Read: { observed: ResourceFacts },
  NotFound: {},
  Unavailable: { message: Schema.String },
})

export type ReadReply = typeof ReadReply.Type

/** What the resource behind a key is called in a sentence. */
export const labelOfKey = (key: ResourceKey): string => Option.match(refOf(key), { onNone: () => key, onSome: labelOf })
