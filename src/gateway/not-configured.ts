import { Schema } from "effect"

/** The gateway was given no key for a system, so it cannot read that system at all. */
export class NotConfigured extends Schema.TaggedError<NotConfigured>()("NotConfigured", {
  /** The setting that holds the key, such as `LINEAR_API_KEY`. */
  setting: Schema.String,
}) {
  override get message(): string {
    return `${this.setting} is not set`
  }
}
