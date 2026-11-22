import { Answer, DecisionKind, Ending } from "./protocol/decision.ts"
import type { DecisionRow, Inbox, QuestionRow } from "./hub/index-store.ts"

const escape = (text: string) =>
  text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`)

const ago = (then: number, now: number) => {
  const minutes = Math.round((now - then) / 60_000)

  if (minutes < 60) return `${minutes} min ago`

  return minutes < 48 * 60 ? `${Math.round(minutes / 60)} h ago` : `${Math.round(minutes / 1440)} days ago`
}

const header = (row: DecisionRow, now: number) => `
  <p class="meta">${escape(row.taskTitle || row.task)} · ${escape(row.session)} · ${ago(row.raisedAt, now)} · ${escape(row.id)}</p>
  <h3>${escape(row.spec.question)}</h3>
  <p>${escape(row.spec.brief)}</p>`

/** A decision that is open, with a button for each option and a box for an answer of my own. */
const openCard = (row: DecisionRow, now: number) => {
  const stance = DecisionKind.match(row.spec.kind, {
    Reversible: ({ undo }) => `The session acts on the recommended option now. To undo it: ${escape(undo)}`,
    Waits: ({ blocks }) => `The session waits. It holds up: ${escape(blocks)}`,
  })

  const options = row.spec.options
    .map((option) => {
      const recommended = option.label === row.spec.recommended

      return `<li${recommended ? ' class="recommended"' : ""}>
        <button name="option" value="${escape(option.label)}">${escape(option.label)}${recommended ? " (recommended)" : ""}</button>
        <span>${escape(option.effect)}</span></li>`
    })
    .join("")

  return `<form class="card" method="post" action="/decisions/${escape(row.id)}/answer">${header(row, now)}
  <p class="why">Recommended because: ${escape(row.spec.reason)}</p>
  <p class="stance">${stance}</p>
  <ul class="options">${options}</ul>
  <label>Note for the session <textarea name="note" rows="1"></textarea></label>
  <label>Or answer in your own words <textarea name="text" rows="2"></textarea></label>
  <button name="option" value="">Send my own answer</button>
</form>`
}

const closedCard = (row: DecisionRow, now: number) => {
  const how =
    row.ending === null
      ? ""
      : Ending.match(row.ending, {
          Answered: ({ answer, note, in: where }) => {
            const given = Answer.match(answer, {
              Chose: ({ option }) => `Chose "${escape(option)}"`,
              Wrote: ({ text }) => `Answered: ${escape(text)}`,
            })

            return `${given} in the ${where}${note === "" ? "" : `. Note: ${escape(note)}`}`
          },
          Superseded: ({ by }) => `Replaced by ${escape(by)}`,
          Withdrawn: ({ reason }) => `Withdrawn: ${escape(reason)}`,
        })

  return `<div class="card closed">${header(row, now)}<p class="ending">${how}</p></div>`
}

const questionCard = (row: QuestionRow) => `<div class="card">
  <p class="meta">${escape(row.taskTitle || row.task)} · ${escape(row.session)} · ${escape(row.kind)}</p>
  <h3>${escape(row.title)}</h3>
  <p class="stance">Answer it in the session for now.</p>
</div>`

const section = (title: string, cards: ReadonlyArray<string>, empty: string) =>
  `<section><h2>${title}</h2>${cards.length === 0 ? `<p class="empty">${empty}</p>` : cards.join("\n")}</section>`

/** The inbox as a page: what waits on me first, then what took its default, then what closed lately. */
export const render = (inbox: Inbox, now: number): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Ratchet inbox</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font: 15px/1.45 system-ui, sans-serif; max-width: 52rem; margin: 2rem auto; padding: 0 1rem; color: #1d1d1f; }
  h2 { font-size: 1rem; text-transform: uppercase; letter-spacing: .04em; color: #555; margin-top: 2rem; }
  h3 { margin: .2rem 0 .4rem; font-size: 1.1rem; }
  .card { border: 1px solid #ddd; border-radius: 8px; padding: .8rem 1rem; margin: .8rem 0; background: #fff; }
  .closed { background: #f7f7f7; }
  .meta, .empty, .stance, .ending { color: #666; font-size: .85rem; margin: .2rem 0; }
  .options { list-style: none; padding: 0; }
  .options li { display: flex; gap: .8rem; align-items: baseline; margin: .4rem 0; }
  .options li span { color: #444; font-size: .9rem; }
  .recommended button { font-weight: 600; border-color: #2a6; }
  button { padding: .3rem .7rem; border: 1px solid #999; border-radius: 6px; background: #fafafa; cursor: pointer; }
  label { display: block; margin: .4rem 0; font-size: .85rem; color: #555; }
  input, textarea { width: 100%; box-sizing: border-box; font: inherit; }
</style></head><body>
<h1>Inbox</h1>
${section("Waiting on you", inbox.waiting.map((row) => openCard(row, now)), "No session waits on you.")}
${section("Questions in sessions", inbox.questions.map(questionCard), "No open question forms or permission requests.")}
${section("Took the recommended option", inbox.defaulted.map((row) => openCard(row, now)), "Nothing to review.")}
${section("Closed lately", inbox.closed.map((row) => closedCard(row, now)), "Nothing yet.")}
</body></html>`
