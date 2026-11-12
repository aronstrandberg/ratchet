# Ratchet

Ratchet tracks work that OpenCode sessions do, follows what that work touches
outside OpenCode, and tells a session or me when something needs action.

## Language

### Work

**Task**: A unit of work I care about, in a tree. It outlives the sessions that
work on it. _Avoid_: Ticket, job, issue

**Session**: An OpenCode conversation I can talk to. It works on one task at a
time and may have worked on others before. _Avoid_: Chat, thread, agent

**Subagent**: A session another session started to help with its task. It is
recorded on that task and has no task of its own. _Avoid_: Child session

**Fork**: A session that starts with another session's history. It gets a child
task of that session's task.

**Board state**: What a task needs right now: `NeedsMe`, `Working`, `Watching`
or `Idle`. It is derived, never set. _Avoid_: Status

### Following

**Resource**: Something outside OpenCode that a task follows. A pull request is
the only kind so far. _Avoid_: Attachment (that is the link, not the thing)

**Attachment**: The link from a task to a resource it follows. It stays with the
task when the session starts another task.

**Relation**: What a resource is to a task: `owns` (the task's session drives
it), `waits_on` (the task needs it done and does not work on it) or `context`
(related, and never a reason to wake anyone).

**Work status**: What a session says about its own work on a resource, such as
`waiting-ci` or `waiting-user`. It is a claim by the session, not a fact from
GitHub. _Avoid_: State, CI status

**Outcome**: How a resource ended: `merged` or `closed`. After that its work
status is history.

**Observation**: What GitHub holds about a pull request at one moment, read in
full and without judgement. _Avoid_: Event, webhook

**Change**: Something that happened to a pull request between two observations,
in terms a task can act on, such as "CI finished" or "a review was submitted".
_Avoid_: Event, diff

**Wake-up**: A message Ratchet puts into a session because a change needs action
from it. It starts a turn. _Avoid_: Notification, ping, nudge

### Parts

**Hub**: The part that holds tasks, sessions and resources and decides what a
change means. It talks to nothing outside.

**Gateway**: The part that holds every connection to the outside: OpenCode and
GitHub. It reports facts and carries out what the hub asks, and decides nothing.

**Cell**: One task, session or resource as a state machine with its own stored
journal. _Avoid_: Actor, entity, object

**Fact**: What the gateway tells the hub about a session, such as "started" or
"asked a question". It carries no message content.
