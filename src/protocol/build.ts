import { Option, Schema } from "effect"

/** One Buildkite build, addressed by its organization, pipeline slug and positive build number. */
export const BuildAddressRef = Schema.Struct({
  organization: Schema.String.pipe(Schema.check(Schema.isPattern(/^[\w.-]+$/))),
  pipeline: Schema.String.pipe(Schema.check(Schema.isPattern(/^[\w.-]+$/))),
  number: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
})

export type BuildAddressRef = typeof BuildAddressRef.Type

/** One Buildkite build as the read-only HTTP route answers it. */
export const BuildDetails = Schema.Struct({
  organization: Schema.String,
  pipeline: Schema.String,
  number: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  state: Schema.String,
  url: Schema.String,
  branch: Schema.String,
  commit: Schema.String,
  message: Schema.NullOr(Schema.String),
  /** When Buildkite created the build, in milliseconds since the epoch. */
  createdAt: Schema.Number,
  /** When the build started, in milliseconds since the epoch, or null while it has not started. */
  startedAt: Schema.NullOr(Schema.Number),
  /** When the build finished, in milliseconds since the epoch, or null while it has not finished. */
  finishedAt: Schema.NullOr(Schema.Number),
  /** The failed jobs, each by its step key or else its name. */
  failedJobs: Schema.Array(Schema.String),
})

export type BuildDetails = typeof BuildDetails.Type

/**
 * What a read of one Buildkite build answers across the Worker's gateway binding.
 *
 * Expected failures are plain tagged values because the HTTP route acts on each one.
 */
export const BuildReadReply = Schema.TaggedUnion({
  Read: { build: BuildDetails },
  BadRequest: { message: Schema.String },
  NotFound: {},
  Unavailable: { reason: Schema.Literals(["not-signed-in", "unavailable"]) },
})

export type BuildReadReply = typeof BuildReadReply.Type

const decodeBuildAddressRef = Schema.decodeUnknownOption(BuildAddressRef)
const buildAddress = /^https:\/\/buildkite\.com\/([\w.-]+)\/([\w.-]+)\/builds\/(\d+)(?:#[^\s#]+)?\s*$/

/** Parses a Buildkite build's browser address. */
export const parseBuildAddress = (address: string): Option.Option<BuildAddressRef> => {
  const [, organization, pipeline, number] = buildAddress.exec(address) ?? []

  return decodeBuildAddressRef({ organization, pipeline, number: Number(number) })
}
