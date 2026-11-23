/**
 * What a change asks of a session that follows its resource.
 *
 * - `act`: the session has something to do, so the message starts a turn.
 * - `screen`: it may: the gateway starts a turn only when a classifier finds the change new to the session
 *   and something it has to act on, and otherwise delivers it as `note` does.
 * - `note`: the session should know, but need not act. The message waits in the session's queue, and the
 *   session reads it with its next turn.
 *
 * A session that is in a turn already gets a screened message the way `note` delivers it: it reads it at
 * its next step, without a turn of its own.
 */
export type Attention = "act" | "screen" | "note"

const rank: Readonly<Record<Attention, number>> = { note: 0, screen: 1, act: 2 }

/** What a batch of changes asks of a session: what its most demanding change asks. */
export const strongest = (levels: ReadonlyArray<Attention>): Attention | null =>
  levels.reduce<Attention | null>((most, level) => (most === null || rank[level] > rank[most] ? level : most), null)
