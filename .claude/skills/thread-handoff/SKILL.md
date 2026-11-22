---
name: thread-handoff
description: Write or update a stream's handoff file (org/handoff/<stream>.md in the project files) when a thread rotates, its context grows long, or work pauses, so the next thread resumes without asking M again.
metadata:
  internal: true
---

# Thread handoff

Handoffs live in the project's shared folder:
`/mnt/project-files/org/handoff/<stream>.md` (one file per stream:
`hardening.md`, `cold-margin.md`, `dte.md`…). They are not in the repo.
Read the existing file first and keep its shape; never start a second
file for the same stream.

## When

- A thread rotates (hardening roughly hourly), its context is long, or
  M pauses the stream.
- Before ending a turn with unpushed work or an open PR nobody watches.

## Times

Take every time from `date -u` and write `HH:MM UTC MM-DD`. Never guess a
time or run ahead of the clock.

## New file

```md
# <Stream> handoff (HH:MM UTC MM-DD)

Goal (M): <the rule or ask driving the stream, with M's date>.
Old thread: <cmsg_...>. Memory index section: <name>.

## State
- What is true now, each line checkable: merged PRs (#n), numbers with where they came from.

## Open PRs
- #n (branch, head sha): what it does, CI state, who is subscribed, what is left (fix red at the root, merge on green).

## Queued
- Next items, in order, each one line with enough to start.

## Tools
- Probes, scripts, env vars, build commands, paths; say which survive a fresh container.

## Gotchas
- Traps that cost time, one line each.
```

## Update to an existing file

Append, never rewrite history:

```md
## Update HH:MM UTC MM-DD (thread <cmsg_...>)
- Merged since last update: #n, #n.
- Open PRs: #n (state), or "none".
- Queued: what the next thread starts on.
- New tools / gotchas, if any.
```

When the top `State`/`Open PRs` lines go stale, mark them done in place
(`#n merged`) so a reader skimming the top is not misled.

## Rules

- Only facts a fresh thread would otherwise have to ask M or rediscover.
  No narrative, no replay of the work; fewest words.
- Every open PR is listed with its head sha and what it waits on. Push
  everything first: the container is reclaimed, the handoff is not a backup.
- Put files the next thread needs (patches, probes) beside it in
  `/mnt/project-files/`, never only in a scratchpad.
- M's new rules go to project memory (MEMORY.md) at once, not only here.
- Write, then re-read the file about 10 s later (shared mount, last write
  wins).
- Tell the coordinator the handoff path when asking for the new thread.
