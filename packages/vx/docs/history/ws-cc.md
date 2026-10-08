# Workstream CC: cache and remote cache

- **CC-1.** A refused restore left an empty directory behind when a later
  entry had created a deeper one (`dist/` then `dist/sub/`): abort pruned in
  staging order and tried `dist/` while `dist/sub/` still held it. Abort now
  prunes newest first. Row (`archive-security.test.ts`):
  `abort prunes a created chain whose deeper directory a later entry created`.

- **CC-2.** A held server's late history used a reading handle, so an index another vx version reset mid-session was refused with a version message. It now opens as a writer and resets silently. Row: keep-alive "records the history after another vx version reset the index mid-session".

- **CC-3.** Two vx versions sharing a store each dropped the other's rows, and the orphan sweep deleted every row-less artifact over an hour old, the other version's live ones included. A row-less artifact is now judged by the retention policy on its file time (`olderThan`; counted under `maxSize`, oldest use first with the rows), a hit renews a file time over an hour old, and temps keep the one-hour rule. Rows: cache-retention › "a row-less artifact younger than the age limit survives the sweep", "a row-less artifact counts toward maxSize, oldest use first with the rows", "a hit or an adopt renews the artifact file time another version judges by", "reaps row-less artifacts a deleted index left past the age limit, silently".

- **CC-4.** Shared store reset raced another vx's open: drop, create and stamp were separate transactions, so an older vx landing after the drop left its tables under this vx's schema stamp. Now one BEGIN IMMEDIATE; a warm open takes no lock and writes no stamp. Rows: `store schema reset > an older vx opening the store mid-reset cannot leave its tables under this schema`, `… a store already at this schema is opened without waiting on its write lock`.

- **CC-5.** Index schema reset raced another vx version: the stamp landed before the tables, so the other version's reset could leave this schema's tables under its stamp. The check, drop, create and stamp are now one IMMEDIATE transaction; a current index still opens lock-free. Rows: `index-schema-race.test.ts` (the two "…cannot leave this schema under its stamp" rows, plus two controls).

- **CC-6.** Store housekeeping pinned silent: the fallback, chmod, move and reset rows now assert everything a run says besides its summary, not one phrase's absence. caching.md's "said once" for the fallback is now "silently". Rows: the four `shared-store.test.ts` rows.

- **CC-7.** A project output glob that only matched under `workspace-outputs/` (`**/*.js`) slipped past X-30's load check: the save stored it, the index read the row as a workspace output, and every hit was dropped as "missing a recorded output" and run again. `planArtifact` now refuses such a file at save. Rows: artifact-roundtrip "a project output under the reserved workspace-outputs/" (refused at save; two controls).

- **CC-8.** `turboCache()` / `nxCache()` named a spent deadline only where `fetch` rejected; a download whose body stalled past it warned "The operation timed out.". The deadline signal's abort reason now names it, so header and body read the same. Rows (`vx-migrate/tests/remote-cache-degrade.test.ts`): `a download whose body stalls names its deadline (turboCache|nxCache)`.

- **CC-9.** `Cache.ingest` left a remote body uncancelled when it refused it by content-length or the temp write failed, so the response stayed held. The catch now cancels the pipe's end, or the body itself when it was never piped. Row: `artifact-ceiling.test.ts` › "an ingest that refuses a body cancels it: no refusal leaves the response held".
