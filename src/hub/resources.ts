import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { type SessionId, TaskId } from "../protocol/ids.ts"
import {
  Outcome,
  Relation,
  ResourceFacts,
  ResourceKey,
  ResourceRef,
  WorkStatus,
  keyOf,
  labelOf,
  refOf,
  subjectOf,
} from "../protocol/resource.ts"
import * as Cells from "./cells.ts"
import * as AlertFeed from "./alert-feed.ts"
import * as CommitBuilds from "./commit-builds.ts"
import * as CommitRuns from "./commit-runs.ts"
import * as Incident from "./incident.ts"
import * as Index from "./index-store.ts"
import * as LinearIssue from "./linear-issue.ts"
import * as PullRequest from "./pull-request.ts"
import * as ResourceSource from "./resource-source.ts"
import { boundTask } from "./session.ts"
import type { Subscriber } from "./subscribers.ts"
import { TaskEvent, isUnborn } from "./task.ts"
import * as Tasks from "./tasks.ts"
import { type Attention, strongest } from "./attention.ts"
import * as WakePolicy from "./wake-policy.ts"
import * as Wakes from "./wakes.ts"

/** No task of the session follows this resource. */
export class NotRegistered extends Schema.TaggedError<NotRegistered>()("NotRegistered", {
  resource: ResourceKey,
}) {
  override get message(): string {
    return `no task of the session follows ${this.resource}`
  }
}

/** Another task owns the resource already, and one task at most may own a resource of this kind. */
export class AlreadyOwned extends Schema.TaggedError<AlreadyOwned>()("AlreadyOwned", {
  resource: ResourceKey,
  owner: TaskId,
}) {
  override get message(): string {
    return `${this.resource} is owned by ${this.owner} already`
  }
}

/** What GitHub last said about a pull request. Only an open one has more than its state. */
const GitHubView = Schema.Struct({
  state: Schema.Literals(["unseen", "open", "merged", "closed"]),
  ci: Schema.optional(Schema.Literals(["Absent", "Running", "Failing", "Finished"])),
  failed: Schema.optional(Schema.Array(Schema.String)),
  reviewDecision: Schema.optional(Schema.NullOr(Schema.String)),
  conflicting: Schema.optional(Schema.Boolean),
  queued: Schema.optional(Schema.Boolean),
  openThreads: Schema.optional(Schema.Int),
})

type GitHubView = typeof GitHubView.Type

/** A resource a task of a session follows, with what its own system last said about it. */
export const Followed = Schema.Struct({
  resource: ResourceKey,
  /** What the resource is called in a sentence, such as `Linear issue DX-1550`. */
  label: Schema.String,
  /** The task that follows it: the session's current task or one it worked on before. */
  task: TaskId,
  relation: Relation,
  status: WorkStatus,
  note: Schema.String,
  /**
   * Where the resource stands in its own system: a pull request's state, an issue's workflow state, an
   * incident's status, or how many of a commit's builds are in each state.
   */
  state: Schema.String,
  /** How it ended, or null while it can still change. */
  ended: Schema.NullOr(Outcome),
  /** More about a pull request. Other kinds of resource have none. */
  github: Schema.optional(GitHubView),
})

export type Followed = typeof Followed.Type

/** The resources the tasks of a session follow. `task` is the session's current task. */
export const Following = Schema.Struct({ task: TaskId, resources: Schema.Array(Followed) })

export type Following = typeof Following.Type

/** A resource and the task of the session that follows it. */
export const Registration = Schema.Struct({ task: TaskId, resource: ResourceKey })

export type Registration = typeof Registration.Type

/** What applying an observation did: the changes it found and how many wake-ups reached their session. */
export interface Observed {
  readonly changes: ReadonlyArray<string>
  readonly woke: number
}

type Failure = Cells.CellUnavailable | Index.IndexError

/** The resources tasks follow: who follows what, what changed, and who is told. */
export interface Interface {
  /**
   * Attaches a resource to a task of the session and reads it from its own system for the first time.
   *
   * The task is the session's current one, unless one of its earlier tasks follows the resource already.
   * `wakes` says whether Ratchet will message the session when the resource needs action.
   */
  readonly register: (
    session: SessionId,
    ref: ResourceRef,
    relation: Relation,
  ) => Effect.Effect<
    Registration & { readonly wakes: boolean },
    | Tasks.NoTask
    | AlreadyOwned
    | ResourceSource.ResourceNotFound
    | ResourceSource.ResourceNotSignedIn
    | ResourceSource.ResourceUnreadable
    | Failure
  >
  /** Records what the session says about its work on a resource one of its tasks follows. */
  readonly setStatus: (
    session: SessionId,
    ref: ResourceRef,
    status: WorkStatus,
    note: string,
  ) => Effect.Effect<Registration, Tasks.NoTask | NotRegistered | Failure>
  /** Stops a task of the session following a resource. */
  readonly unregister: (
    session: SessionId,
    ref: ResourceRef,
  ) => Effect.Effect<Registration, Tasks.NoTask | NotRegistered | Failure>
  /** The resources the session's tasks follow, with what its own system last said about each. */
  readonly list: (session: SessionId) => Effect.Effect<Following, Tasks.NoTask | Cells.CellUnavailable>
  /**
   * Applies a fresh observation of a resource, queues a wake-up for each session it concerns, and delivers
   * those wake-ups.
   *
   * A pull request that merged while it was followed has the builds and the infrastructure runs of its merge
   * commit followed from then on, by the tasks that own it.
   */
  readonly observe: (observed: ResourceFacts) => Effect.Effect<Observed, Failure>
  /** The resources worth reading again: someone follows them and they have not ended. */
  readonly watched: Effect.Effect<ReadonlyArray<ResourceRef>, Index.IndexError>
}

/** The hub's resources. */
export class Service extends Context.Service<Service, Interface>()("@ratchet/hub/Resources") {}

/** Something that happened to a resource, in the form every kind of resource shares. */
interface Notice {
  /** The name of the change, such as `CiFinished` or `Commented`. */
  readonly tag: string
  /** One line a session can read. */
  readonly text: string
  /** What it asks of a session of a task with this relation to the resource, or null for nothing. */
  readonly attention: (relation: Relation) => Attention | null
}

/** A resource's cell as every kind of resource shows it. */
interface Standing {
  readonly subscribers: ReadonlyArray<Subscriber>
  readonly outcome: Outcome | null
  /** Where the resource stands in its own system. */
  readonly state: string
  readonly github?: GitHubView
}

/** What a kind of resource lets the hub do with one resource's cell. */
interface Cell {
  readonly standing: Effect.Effect<Standing, Cells.CellUnavailable>
  readonly attach: (subscriber: Subscriber) => Effect.Effect<Standing, Failure>
  readonly detach: (task: TaskId) => Effect.Effect<Standing, Failure>
}

/** What an observation changed, in the form every kind of resource shares. */
interface Applied {
  /** What the resource is called in a wake-up. */
  readonly label: string
  readonly standing: Standing
  readonly notices: ReadonlyArray<Notice>
  /** What tells one batch of changes from the next: a pull request's head, and nothing for other kinds. */
  readonly version: string
  /** The resources the tasks that own this one follow from now on, because of what changed. Most changes add none. */
  readonly follows?: ReadonlyArray<ResourceRef>
}

const githubView = (state: PullRequest.PullRequestState): GitHubView =>
  PullRequest.PullRequestState.$match<GitHubView>(state, {
    Unseen: () => ({ state: "unseen" }),
    Merged: () => ({ state: "merged" }),
    Closed: () => ({ state: "closed" }),
    Open: (open) => ({
      state: "open",
      ci: open.ci._tag,
      failed: PullRequest.failedChecks(open.ci),
      reviewDecision: open.reviewDecision,
      conflicting: open.conflicting,
      queued: open.queued,
      openThreads: open.threads.filter((thread) => !thread.resolved).length,
    }),
  })

const pullRequestStanding = (state: PullRequest.PullRequestState): Standing => {
  const github = githubView(state)

  return { subscribers: state.subscribers, outcome: PullRequest.outcomeOf(state), state: github.state, github }
}

const linearIssueStanding = (state: LinearIssue.LinearIssueState): Standing => ({
  subscribers: state.subscribers,
  outcome: LinearIssue.outcomeOf(state),
  state: LinearIssue.LinearIssueState.$match(state, { Unseen: () => "unseen", Seen: ({ issue }) => issue.state.name }),
})

const incidentStanding = (state: Incident.IncidentState): Standing => ({
  subscribers: state.subscribers,
  outcome: Incident.outcomeOf(state),
  state: Incident.IncidentState.$match(state, { Unseen: () => "unseen", Seen: ({ incident }) => incident.status.name }),
})

const commitBuildsStanding = (state: CommitBuilds.CommitBuildsState): Standing => ({
  subscribers: state.subscribers,
  outcome: CommitBuilds.outcomeOf(state),
  state: CommitBuilds.summaryOf(state),
})

const commitRunsStanding = (state: CommitRuns.CommitRunsState): Standing => ({
  subscribers: state.subscribers,
  outcome: CommitRuns.outcomeOf(state),
  state: CommitRuns.summaryOf(state),
})

const alertFeedStanding = (state: AlertFeed.AlertFeedState): Standing => ({
  subscribers: state.subscribers,
  outcome: null,
  state: AlertFeed.summaryOf(state),
})

const owns = (subscriber: Subscriber) => subscriber.relation === "owns"

/** The task a wake-up is about, as the woken session should read it. */
interface Subject {
  readonly title: string
  /** Whether it is the task the session works on now. */
  readonly current: boolean
  /** What the session last said about its work on the resource, or null when it said nothing. */
  readonly said: { readonly status: WorkStatus; readonly note: string } | null
}

const wakeText = (label: string, relevant: ReadonlyArray<Notice>, subject: Subject) =>
  [
    `Ratchet: ${label} changed.`,
    ...relevant.map((notice) => `- ${notice.text}`),
    subject.current
      ? `It belongs to your task "${subject.title}".`
      : `It belongs to "${subject.title}", a task you worked on before the one you work on now.`,
    // The screen reads this too: what a session said it waits for tells whether the change is for it.
    ...(subject.said === null
      ? []
      : [`You last said of your work on it: ${subject.said.status}${subject.said.note === "" ? "" : `, "${subject.said.note}"`}.`]),
    "This is an automatic notification, not a message from Aron. Read it at its source before you act on it.",
  ].join("\n")

/** Builds the resources on the cells, the tasks, the index, the gateway's reads and the messages to sessions. */
export const make = Effect.gen(function* () {
  const cells = yield* Cells.Service
  const tasks = yield* Tasks.Service
  const index = yield* Index.Service
  const source = yield* ResourceSource.Service
  const wakes = yield* Wakes.Service
  const policy = yield* WakePolicy.Service

  /** The cell of a resource, whatever its kind. */
  const cellOf = (ref: ResourceRef): Cell => {
    const key = keyOf(ref)

    return ResourceRef.match(ref, {
      PullRequest: (): Cell => ({
        standing: Effect.map(cells.pullRequest(key), pullRequestStanding),
        attach: (subscriber) =>
          Effect.map(cells.sendPullRequest(key, PullRequest.PullRequestEvent.Attached({ subscriber })), pullRequestStanding),
        detach: (task) =>
          Effect.map(cells.sendPullRequest(key, PullRequest.PullRequestEvent.Detached({ task })), pullRequestStanding),
      }),
      LinearIssue: (): Cell => ({
        standing: Effect.map(cells.linearIssue(key), linearIssueStanding),
        attach: (subscriber) =>
          Effect.map(cells.sendLinearIssue(key, LinearIssue.LinearIssueEvent.Attached({ subscriber })), linearIssueStanding),
        detach: (task) =>
          Effect.map(cells.sendLinearIssue(key, LinearIssue.LinearIssueEvent.Detached({ task })), linearIssueStanding),
      }),
      Incident: (): Cell => ({
        standing: Effect.map(cells.incident(key), incidentStanding),
        attach: (subscriber) =>
          Effect.map(cells.sendIncident(key, Incident.IncidentEvent.Attached({ subscriber })), incidentStanding),
        detach: (task) => Effect.map(cells.sendIncident(key, Incident.IncidentEvent.Detached({ task })), incidentStanding),
      }),
      CommitBuilds: (): Cell => ({
        standing: Effect.map(cells.commitBuilds(key), commitBuildsStanding),
        attach: (subscriber) =>
          Effect.map(
            cells.sendCommitBuilds(key, CommitBuilds.CommitBuildsEvent.Attached({ subscriber })),
            commitBuildsStanding,
          ),
        detach: (task) =>
          Effect.map(cells.sendCommitBuilds(key, CommitBuilds.CommitBuildsEvent.Detached({ task })), commitBuildsStanding),
      }),
      AlertFeed: (): Cell => ({
        standing: Effect.map(cells.alertFeed(key), alertFeedStanding),
        attach: (subscriber) =>
          Effect.map(cells.sendAlertFeed(key, AlertFeed.AlertFeedEvent.Attached({ subscriber })), alertFeedStanding),
        detach: (task) => Effect.map(cells.sendAlertFeed(key, AlertFeed.AlertFeedEvent.Detached({ task })), alertFeedStanding),
      }),
      CommitRuns: (): Cell => ({
        standing: Effect.map(cells.commitRuns(key), commitRunsStanding),
        attach: (subscriber) =>
          Effect.map(cells.sendCommitRuns(key, CommitRuns.CommitRunsEvent.Attached({ subscriber })), commitRunsStanding),
        detach: (task) =>
          Effect.map(cells.sendCommitRuns(key, CommitRuns.CommitRunsEvent.Detached({ task })), commitRunsStanding),
      }),
    })
  }

  /**
   * Hands an observation to its resource's cell and says what it changed.
   *
   * An observation that repeats what the cell holds is not handed over: the cell would store it, and the
   * gateway reads every followed resource once a minute.
   */
  const apply = (observed: ResourceFacts): Effect.Effect<Applied, Failure> => {
    const key = keyOf(subjectOf(observed))
    const label = labelOf(subjectOf(observed))

    return ResourceFacts.match(observed, {
      PullRequest: ({ facts }) =>
        Effect.gen(function* () {
          const before = yield* cells.pullRequest(key)

          if (PullRequest.repeats(before, facts)) {
            return { label, standing: pullRequestStanding(before), version: "", notices: [] }
          }

          const after = yield* cells.sendPullRequest(key, PullRequest.PullRequestEvent.Observed({ facts }))

          const applied = {
            label,
            standing: pullRequestStanding(after),
            version: facts.head.slice(0, 12),
            notices: PullRequest.changes(before, after).map((change) => ({
              tag: change._tag,
              text: PullRequest.describe(change),
              attention: (relation: Relation) => PullRequest.attention(relation, change),
            })),
          }

          if (facts.mergeCommit === null || !PullRequest.mergedWhileFollowed(before, after)) return applied

          // A merge starts builds on the base branch and runs of the stacks the change touches. Nothing
          // else tells the session that merged it when a build fails or a run waits for someone.
          const merged = { owner: facts.ref.owner, repo: facts.ref.repo, commit: facts.mergeCommit }

          return {
            ...applied,
            follows: [ResourceRef.cases.CommitBuilds.make(merged), ResourceRef.cases.CommitRuns.make(merged)],
          }
        }),
      LinearIssue: ({ facts }) =>
        Effect.gen(function* () {
          const before = yield* cells.linearIssue(key)

          if (LinearIssue.repeats(before, facts)) {
            return { label, standing: linearIssueStanding(before), version: "", notices: [] }
          }

          const after = yield* cells.sendLinearIssue(key, LinearIssue.LinearIssueEvent.Observed({ facts }))

          return {
            label,
            standing: linearIssueStanding(after),
            version: "",
            notices: LinearIssue.changes(before, after).map((change) => ({
              tag: change._tag,
              text: LinearIssue.describe(change),
              attention: (relation: Relation) => LinearIssue.attention(relation, change),
            })),
          }
        }),
      Incident: ({ facts }) =>
        Effect.gen(function* () {
          const before = yield* cells.incident(key)

          if (Incident.repeats(before, facts)) {
            return { label, standing: incidentStanding(before), version: "", notices: [] }
          }

          const after = yield* cells.sendIncident(key, Incident.IncidentEvent.Observed({ facts }))

          return {
            label,
            standing: incidentStanding(after),
            version: "",
            notices: Incident.changes(before, after).map((change) => ({
              tag: change._tag,
              text: Incident.describe(change),
              attention: (relation: Relation) => Incident.attention(relation, change),
            })),
          }
        }),
      CommitBuilds: ({ facts }) =>
        Effect.gen(function* () {
          const before = yield* cells.commitBuilds(key)
          const at = yield* Clock.currentTimeMillis
          // A commit's hash says nothing to a session, so the wake-up also names what the commit is.
          const named = facts.title === "" ? label : `${label}, "${facts.title}",`

          if (CommitBuilds.repeats(before, facts, at)) {
            return { label: named, standing: commitBuildsStanding(before), version: "", notices: [] }
          }

          const after = yield* cells.sendCommitBuilds(key, CommitBuilds.CommitBuildsEvent.Observed({ facts, at }))

          return {
            label: named,
            standing: commitBuildsStanding(after),
            version: "",
            notices: CommitBuilds.changes(before, after).map((change) => ({
              tag: change._tag,
              text: CommitBuilds.describe(change),
              attention: (relation: Relation) => CommitBuilds.attention(relation, change),
            })),
          }
        }),
      AlertFeed: ({ facts }) =>
        Effect.gen(function* () {
          const before = yield* cells.alertFeed(key)

          if (AlertFeed.repeats(before, facts)) {
            return { label, standing: alertFeedStanding(before), version: "", notices: [] }
          }

          const at = yield* Clock.currentTimeMillis
          const after = yield* cells.sendAlertFeed(key, AlertFeed.AlertFeedEvent.Observed({ facts, at }))

          return {
            label,
            standing: alertFeedStanding(after),
            version: "",
            notices: AlertFeed.changes(before, after).map((change) => ({
              tag: change._tag,
              text: AlertFeed.describe(change),
              attention: (relation: Relation) => AlertFeed.attention(relation, change),
            })),
          }
        }),
      CommitRuns: ({ facts }) =>
        Effect.gen(function* () {
          const before = yield* cells.commitRuns(key)
          const at = yield* Clock.currentTimeMillis
          const named = facts.title === "" ? label : `${label}, "${facts.title}",`

          if (CommitRuns.repeats(before, facts, at)) {
            return { label: named, standing: commitRunsStanding(before), version: "", notices: [] }
          }

          const after = yield* cells.sendCommitRuns(key, CommitRuns.CommitRunsEvent.Observed({ facts, at }))

          return {
            label: named,
            standing: commitRunsStanding(after),
            version: "",
            notices: CommitRuns.changes(before, after).map((change) => ({
              tag: change._tag,
              text: CommitRuns.describe(change),
              attention: (relation: Relation) => CommitRuns.attention(relation, change),
            })),
          }
        }),
    })
  }

  const attachmentsOf = (task: TaskId) =>
    Effect.map(cells.task(task), (state) => (isUnborn(state) ? [] : state.attachments))

  /**
   * The task of the session that follows a resource.
   *
   * A resource stays with the task it was attached to when its session starts another task, so this looks
   * through every task the session has worked on, the current one first.
   */
  const followerOf = Effect.fn("Resources.followerOf")(function* (session: SessionId, key: ResourceKey) {
    for (const task of yield* tasks.tasksOf(session)) {
      if ((yield* attachmentsOf(task)).some((attachment) => attachment.resource === key)) return Option.some(task)
    }

    return Option.none<TaskId>()
  })

  const followerOrFail = (session: SessionId, key: ResourceKey) =>
    Effect.flatMap(
      followerOf(session, key),
      Option.match({
        onNone: () => Effect.fail(new NotRegistered({ resource: key })),
        onSome: (task) => Effect.succeed(task),
      }),
    )

  const detach = Effect.fn("Resources.detach")(function* (task: TaskId, ref: ResourceRef) {
    yield* cellOf(ref).detach(task)
    yield* cells.sendTask(task, TaskEvent.Detached({ resource: keyOf(ref) }))
  })

  /** Applies an observation and tells the tasks it concerns. */
  const settle = Effect.fn("Resources.settle")(function* (observed: ResourceFacts) {
    const key = keyOf(subjectOf(observed))
    const { label, standing, notices, version, follows } = yield* apply(observed)
    const now = yield* Clock.currentTimeMillis

    // Every follower learns that it ended, whether or not its session is woken.
    if (standing.outcome !== null && notices.length > 0) {
      for (const subscriber of standing.subscribers) {
        yield* cells.sendTask(subscriber.task, TaskEvent.ResourceEnded({ resource: key, outcome: standing.outcome }))
      }
    }

    let woke = 0

    for (const subscriber of standing.subscribers) {
      const relevant = notices.filter((notice) => notice.attention(subscriber.relation) !== null)
      const level = strongest(notices.flatMap((notice) => Option.toArray(Option.fromNullOr(notice.attention(subscriber.relation)))))

      if (relevant.length === 0 || !WakePolicy.allows(policy, subscriber.session)) continue
      const task = yield* cells.task(subscriber.task)

      if (isUnborn(task)) continue
      const current = boundTask(yield* cells.session(subscriber.session)) === subscriber.task
      const attachment = task.attachments.find((held) => held.resource === key)
      const said = attachment === undefined || attachment.status === "unassigned" ? null : attachment
      woke += yield* wakes.send(subscriber.task, {
        // One batch of changes has one ID, so the same observation never wakes a session twice.
        id: `${key}@${version === "" ? now : version}:${relevant.map((notice) => notice.tag).join("+")}`,
        session: subscriber.session,
        text: wakeText(label, relevant, { title: task.title, current, said }),
        resume: level !== "note",
        screen: level === "screen",
      })
    }

    return { changes: notices.map((notice) => notice.tag), woke, owners: standing.subscribers.filter(owns), follows }
  })

  /**
   * Attaches a resource to a task and reads it from its own system for the first time.
   *
   * The first read gives the task something to show. A resource that its own system does not have, or that
   * the gateway is not signed in to read, is not followed.
   */
  const follow = Effect.fn("Resources.follow")(function* (subscriber: Subscriber, ref: ResourceRef) {
    const key = keyOf(ref)
    const { task, session, relation } = subscriber
    const attached = yield* cellOf(ref).attach(subscriber)

    // A resource that one task at most may own leaves a second owner out of its subscribers.
    if (!attached.subscribers.some((subscriber) => subscriber.task === task)) {
      const owner = attached.subscribers.find((subscriber) => subscriber.relation === "owns")

      return yield* new AlreadyOwned({ resource: key, owner: owner?.task ?? task })
    }

    yield* cells.sendTask(task, TaskEvent.Attached({ resource: key, relation, session }))

    const observed = yield* source.read(ref).pipe(
      Effect.tapErrorTag("ResourceNotFound", () => detach(task, ref)),
      Effect.tapErrorTag("ResourceNotSignedIn", () => detach(task, ref)),
    )

    return yield* settle(observed)
  })

  const observe = Effect.fn("Resources.observe")(function* (observed: ResourceFacts) {
    const { changes, woke, owners, follows } = yield* settle(observed)

    for (const next of follows ?? []) {
      for (const owner of owners) {
        // What cannot be followed is not a reason to lose the observation that led to it. A commit that
        // nothing carries is the usual case: its repository has no CI, or no stack planned its change.
        yield* follow(owner, next).pipe(
          Effect.catch((failure) => Effect.logInfo(`${labelOf(next)} is not followed for ${owner.task}: ${failure.message}`)),
        )
      }
    }

    return { changes, woke }
  })

  const register = Effect.fn("Resources.register")(function* (session: SessionId, ref: ResourceRef, relation: Relation) {
    const follower = yield* followerOf(session, keyOf(ref))
    const task = Option.isSome(follower) ? follower.value : yield* tasks.taskOf(session)
    yield* follow({ task, session, relation }, ref)

    return { task, resource: keyOf(ref), wakes: relation !== "context" && WakePolicy.allows(policy, session) }
  })

  const setStatus = Effect.fn("Resources.setStatus")(function* (
    session: SessionId,
    ref: ResourceRef,
    status: WorkStatus,
    note: string,
  ) {
    const key = keyOf(ref)
    const task = yield* followerOrFail(session, key)
    yield* cells.sendTask(task, TaskEvent.StatusSet({ resource: key, status, note }))

    return { task, resource: key }
  })

  const unregister = Effect.fn("Resources.unregister")(function* (session: SessionId, ref: ResourceRef) {
    const key = keyOf(ref)
    const task = yield* followerOrFail(session, key)
    yield* detach(task, ref)

    return { task, resource: key }
  })

  const list = Effect.fn("Resources.list")(function* (session: SessionId) {
    const rows: Array<Followed> = []

    for (const follower of yield* tasks.tasksOf(session)) {
      for (const attachment of yield* attachmentsOf(follower)) {
        const ref = refOf(attachment.resource)

        if (Option.isNone(ref)) continue
        const standing = yield* cellOf(ref.value).standing

        const row = {
          resource: attachment.resource,
          label: labelOf(ref.value),
          task: follower,
          relation: attachment.relation,
          status: attachment.status,
          note: attachment.note,
          state: standing.state,
          ended: standing.outcome,
        }

        rows.push(standing.github === undefined ? row : { ...row, github: standing.github })
      }
    }

    return { task: yield* tasks.taskOf(session), resources: rows }
  })

  const watched = Effect.map(index.resources("watched"), (rows) => rows.flatMap((row) => Option.toArray(refOf(row.key))))

  return Service.of({ register, setStatus, unregister, list, observe, watched })
})

/** The resources, still in need of everything they are built on. */
export const layerWithoutDependencies = Layer.effect(Service, make)
