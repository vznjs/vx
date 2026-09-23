---
title: Caching, from first principles
description: Content addressing, what goes into a cache key, why a key hashes inputs and not outputs, and local versus remote caches.
---

:::note
Status: planned (roadmap W2).
:::

This page will teach caching from first principles: content addressing,
what goes into a cache key, why the key folds the inputs of upstream tasks
and not their outputs, what makes a hit stale, and what changes when the
cache is remote. Its widget will be a key calculator: change an input, an
environment variable or an upstream task, and watch the key and its
dependents change. After reading it you should be able to predict what a
change reruns and say why a cache hit is safe or stale.
