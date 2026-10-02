# Worker J2 — docs accuracy: the record

## Entries

- **J2-4** Two module pages a fix left behind (the commit updated cli.md
  or caching.md, not the page for the file it changed).
  `modules/summary.md` said the result row's rate is over the tasks
  that have a cache; since #2212 a skipped task (and one still to run)
  is out of it. `modules/git-inputs.md` presented the blob-size check
  as catching a removed filter; since #2226 caching.md says a filter
  that kept the size passes. Rows (`module-page-claims`), red on both
  pages without the fix.
