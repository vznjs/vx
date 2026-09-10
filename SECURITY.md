# Security

vx runs the commands you declare, on your machine, and caches their
outputs. Its security-relevant surfaces are the cache (a stale or forged
hit replays wrong bytes under a green run), remote cache and remote
execution plugins (bytes from a network), and the per-task sandbox.

**Report a vulnerability privately** through GitHub's private
vulnerability reporting on this repository (Security → Report a
vulnerability), or to the maintainers listed on the npm package. Do not
open a public issue for a security problem. You will get an
acknowledgement within a few days and a fix or a written assessment
before any public disclosure.

What is in scope: anything that makes vx replay wrong bytes as a cache
hit, run a command it was not asked to run, read or write outside a
task's declared surface while the sandbox says otherwise, or accept a
remote artifact whose digest does not match.

What is not: the behaviour of the commands you configure, or of a
plugin published by someone else.
