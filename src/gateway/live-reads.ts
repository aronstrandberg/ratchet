import { Clock, Duration, Effect, Option, Ref, Stream } from "effect"
import { ResourceRef, keyOf, parseReference } from "../protocol/resource.ts"
import * as HubReports from "./hub-reports.ts"
import * as ResourcePoll from "./resource-poll.ts"
import * as WebhookProxy from "./webhook-proxy.ts"

/** How the gateway's listening to the webhook proxy is doing. */
export interface Status {
  /** The pull requests a live connection covers, by key. The proxy tells the gateway when one of them changes. */
  readonly covered: ReadonlyArray<string>
  /** Frames heard, and reads they led to, since the listener's holder woke. */
  readonly frames: number
  readonly reads: number
  /** What keeps the gateway from listening now, or null. It goes when a connection hears the proxy again. */
  readonly problem: string | null
}

/** The status of a listener that has not started. */
export const idle: Status = { covered: [], frames: 0, reads: 0, problem: null }

/** What the listening is tuned by. */
export interface Config {
  /** The repositories whose events reach the proxy, as `owner/repo` in lower case. */
  readonly repos: ReadonlyArray<string>
  /** How long after a frame its pull request is read. GitHub's API lags its events by a moment, and frames come in bursts. */
  readonly prompt: Duration.Input
  /**
   * How long after a check passed its pull request is read. A passed check matters when it is the last one,
   * and a push ends some fifty of them.
   */
  readonly relaxed: Duration.Input
  /** How often the pull requests the hub watches are compared with the ones listened to. */
  readonly recheck: Duration.Input
}

/** The most scopes the proxy takes on one stream. */
const perStream = 20

/** The most frame IDs remembered, to tell a frame the proxy sends twice from a new one. */
const remembered = 1000

/** The scopes to listen to: the watched pull requests of the repositories whose events reach the proxy. */
export const scopesOf = (watched: ReadonlyArray<ResourceRef>, repos: ReadonlyArray<string>): ReadonlyArray<string> =>
  watched
    .flatMap((ref) =>
      ResourceRef.guards.PullRequest(ref) && repos.includes(`${ref.owner}/${ref.repo}`.toLowerCase()) ? [keyOf(ref)] : [],
    )
    .toSorted()

const same = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) => a.length === b.length && a.every((scope, at) => scope === b[at])

const streamsOf = (scopes: ReadonlyArray<string>): ReadonlyArray<ReadonlyArray<string>> =>
  Array.from({ length: Math.ceil(scopes.length / perStream) }, (_, at) => scopes.slice(at * perStream, (at + 1) * perStream))

const passedCheck = (frame: typeof WebhookProxy.Frame.cases.Event.Type) =>
  frame.type === "check_run" && ["success", "neutral", "skipped"].includes(frame.conclusion ?? "")

/**
 * Listens to the webhook proxy for the pull requests the hub watches, and reads a pull request from GitHub
 * when a frame says it changed. It runs for as long as it is not interrupted.
 *
 * A frame is a hint and never state. The slower reading of every watched resource goes on, so a frame that
 * is missed, or a proxy that sends none, costs only speed.
 */
export const run = (
  status: Ref.Ref<Status>,
  config: Config,
): Effect.Effect<never, never, WebhookProxy.Service | ResourcePoll.Readers> =>
  Effect.gen(function* () {
    const proxy = yield* WebhookProxy.Service
    const hub = yield* HubReports.Service
    const due = yield* Ref.make(new Map<string, number>())
    const heard = yield* Ref.make(new Set<string>())
    const failed = (problem: string) => Ref.update(status, (held) => ({ ...held, problem: problem.slice(0, 500) }))

    const cover = (scopes: ReadonlyArray<string>, covered: boolean) =>
      Ref.update(status, (held) => {
        const others = held.covered.filter((scope) => !scopes.includes(scope))

        return covered ? { ...held, covered: [...others, ...scopes].toSorted(), problem: null } : { ...held, covered: others }
      })

    /** Has a pull request read after the delay, or sooner when a read is due sooner already. */
    const schedule = (scope: string, delay: Duration.Input) =>
      Effect.flatMap(Clock.currentTimeMillis, (now) =>
        Ref.update(due, (held) => {
          const at = now + Duration.toMillis(delay)

          return new Map(held).set(scope, Math.min(held.get(scope) ?? at, at))
        }),
      )

    const isNew = (id: string) =>
      Ref.modify(heard, (held) => {
        if (held.has(id)) return [false, held]

        return [true, new Set([...(held.size >= remembered ? [] : held), id])]
      })

    const hear = (scopes: ReadonlyArray<string>, cursor: Ref.Ref<Option.Option<string>>) =>
      WebhookProxy.Frame.match({
        Event: (frame) =>
          Effect.gen(function* () {
            yield* Ref.set(cursor, Option.some(frame.id))

            // The proxy takes a stream up from a little before the cursor, so a frame can come twice.
            if (!(yield* isNew(frame.id))) return
            yield* Ref.update(status, (held) => ({ ...held, frames: held.frames + 1 }))

            for (const number of frame.pullRequests) {
              const scope = `${frame.repo}#${number}`

              if (scopes.includes(scope)) yield* schedule(scope, passedCheck(frame) ? config.relaxed : config.prompt)
            }
          }),
        Heartbeat: (frame) => (frame.cursor === null ? Effect.void : Ref.set(cursor, Option.some(frame.cursor))),
        // Events were missed, and the proxy does not say whose.
        Gap: () => Effect.forEach(scopes, (scope) => schedule(scope, config.prompt), { discard: true }),
        Expired: () => Effect.void,
      })

    /** Holds one stream for the scopes given, and opens it again each time it ends. */
    const listen = (scopes: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const cursor = yield* Ref.make(Option.none<string>())
        let failures = 0

        while (true) {
          const ended = yield* proxy.frames(scopes, yield* Ref.get(cursor)).pipe(
            Stream.runForEach((frame) => Effect.andThen(cover(scopes, true), hear(scopes, cursor)(frame))),
            Effect.as(null),
            Effect.catch((failure) => Effect.succeed(failure.message)),
            Effect.ensuring(cover(scopes, false)),
          )

          failures = ended === null ? 0 : failures + 1

          if (ended !== null) yield* failed(ended)
          // The proxy closes a connection about every ten minutes. A refused one is tried less and less often.
          yield* Effect.sleep(ended === null ? "1 second" : `${Math.min(2 ** failures, 60)} seconds`)
        }
      })

    const wanted = hub.watchedResources.pipe(
      Effect.map((watched) => Option.some(scopesOf(watched, config.repos))),
      Effect.catch((failure) => Effect.as(failed(failure.message), Option.none<ReadonlyArray<string>>())),
    )

    /** Waits until the hub watches other pull requests than the ones listened to, and answers which. */
    const untilChanged = (scopes: ReadonlyArray<string>): Effect.Effect<ReadonlyArray<string>, never, never> =>
      Effect.gen(function* () {
        while (true) {
          yield* Effect.sleep(config.recheck)
          const next = yield* wanted

          if (Option.isSome(next) && !same(next.value, scopes)) return next.value
        }
      })

    const listening = Effect.gen(function* () {
      let scopes: ReadonlyArray<string> = Option.getOrElse(yield* wanted, () => [])

      while (true) {
        const streams = Effect.forEach(streamsOf(scopes), listen, { concurrency: "unbounded", discard: true })
        // The streams never end by themselves, so this waits for the watched pull requests to change.
        scopes = yield* Effect.raceFirst(Effect.andThen(streams, Effect.never), untilChanged(scopes))
      }
    })

    const reading = Effect.gen(function* () {
      while (true) {
        yield* Effect.sleep("1 second")
        const now = yield* Clock.currentTimeMillis
        const ready = [...(yield* Ref.get(due))].flatMap(([scope, at]) => (at <= now ? [scope] : []))

        for (const scope of ready) {
          yield* Ref.update(due, (held) => {
            const rest = new Map(held)
            rest.delete(scope)

            return rest
          })

          const ref = parseReference(scope)

          if (Option.isNone(ref)) continue
          yield* ResourcePoll.follow(ref.value)
          yield* Ref.update(status, (held) => ({ ...held, reads: held.reads + 1 }))
        }
      }
    })

    return yield* Effect.all([listening, reading], { concurrency: "unbounded", discard: true }).pipe(Effect.andThen(Effect.never))
  })
