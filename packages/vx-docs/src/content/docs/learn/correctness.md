---
title: 'Correctness: can you trust the cache?'
description: Declared versus inferred inputs, the stale-hit failure class, and the sandbox as proof of what a task touched.
---

:::note
Status: planned (roadmap W3).
:::

This page will teach why a stale hit is the worst failure a task cache can
have: a green run that replays the wrong bytes. It will compare declared
inputs with inferred ones, and show the sandbox as the proof of what a task
touched. Its widget will edit an input the config never declared, replay
the wrong bytes, and show the sandbox violation that catches it. After
reading it you should be able to say why a cache hit is safe or stale.
