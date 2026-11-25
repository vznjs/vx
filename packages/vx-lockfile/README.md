# @vzn/vx-lockfile

Website: <https://vznjs.github.io/vx/> · this plugin: <https://vznjs.github.io/vx/plugins/vx-lockfile/> · source: <https://github.com/vznjs/vx>

Lockfile plugins for [`@vzn/vx`](https://vznjs.github.io/vx/): `bun()`, `pnpm()`, `npm()` and `yarn()`. Each one reads your package manager's lockfile.

It keys each task on its **own project's resolved dependencies**, not on the whole file. A project reaches a package through its dependencies, transitively, and through workspace links.

So `pnpm update foo` (or `bun add`, `npm install`, `yarn up`) re-keys only the projects that reach `foo`. `vx run … --affected` selects the same projects.

Each plugin also:

- gives vx the **projects, names and edges the lockfile records** (`discover`);
- adds each package's manifest to its cached tasks' inputs: `package.json`, or under `pnpm()` a `package.json5` or `package.yaml` where it has none, as pnpm reads them;
- hashes the manager's install settings into every task.

It has no dependencies. It uses Bun's own YAML and JSONC parsers, and yarn's own readers (classic, and berry's).

Berry's reader reads every value as its text: an unquoted range `0.10` is not the number `0.1`.

Core keys no package file. Without a plugin, no lockfile, install setting or `package.json` reaches any cache key.

So without one, an install re-keys nothing, and a build made against the old `node_modules` replays. A JS workspace declares one of these plugins.

## Usage

```sh
bun add -d @vzn/vx @vzn/vx-lockfile
```

```ts
// .vx/workspace.ts
import { defineWorkspace } from '@vzn/vx/config'
import { pnpm } from '@vzn/vx-lockfile' // or bun, npm, yarn

export default defineWorkspace({
  plugins: [pnpm()],
})
```

That is the whole setup. The plugin **owns** its lockfile and its manager's install settings (`VxPlugin.fingerprint`).

Its `key` hook hashes one digest per project, plus each settings file present, into the key.

`vx lock` records the digests in `.vx/dependencies.lock`, and a run keys from that record. After an install, run `vx lock` and commit the file.

A run whose lockfile changed since the record refuses until you do.

An edit in a `link:` or `file:` directory the lockfile names, or in a patch, needs no `vx lock`. The run sees it moved since the record and digests it anew.

`vx why <task>` names the material as `plugin @vzn/vx-lockfile/pnpm` (or `/bun`, `/npm`, `/yarn`).

A settings file that moved shows as `plugin @vzn/vx-lockfile/.npmrc`, or with that file's name.

With no lockfile at the workspace root (before the first install), it warns and keys no package's dependencies. A `^build` then has no edges to follow, and the run refuses it.

| Option  | Values                               | Meaning                                                                                                                                                                         |
| ------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scope` | `'project'` (default), `'workspace'` | `project`: each task keys on its own project's closure. `workspace`: the whole file in every task's key — the coarse key, for a workspace not yet ready to trust the precision. |

## What a project's digest covers

A project's digest covers every package the project can reach, plus the root package's own closure. If `packages/a` reaches `lodash`, a `lodash` bump re-keys `a`.

- Each package counts by its resolved identity: name, version and integrity.
- Under bun and npm it counts by the name it installs under, not where it sits. So a re-hoist of one version re-keys nothing.
- The install-wide material every project hashes is in it too.

The root's `dependencies` and `devDependencies` reach every task:

- their bins run from the root `node_modules/.bin`, which vx puts on every task's PATH;
- Node's resolution walks up to the root `node_modules` (`@types/*`, a plugin a root tool's config names).

So a root devDependency bump (`pnpm add -Dw oxlint@next`) re-keys every project, and `--affected` selects every project.

A package only project A reaches still moves only A. A root `workspace:` dependency hashes that package's closure into every project too.

The field each dependency sits in is in the digest too, for the root and each workspace: `dependencies`, `devDependencies` or `optionalDependencies`.

An install that leaves dev or optional packages out lays `node_modules` out by that field: npm `omit=dev`, `pnpm install --prod`, `bun install --production`.

So moving a root dependency to `devDependencies` re-keys every project, and `--affected` selects them.

A build that would now fail with "Cannot find module" does not replay its old success.

yarn.lock records no field, so `yarn()` reads the root `package.json`'s instead (see Install settings). Each manager's own rules follow.

<details><summary>pnpm details</summary>

The file is `pnpm-lock.yaml`, lockfile v5, v6, v9 and v13.

- It walks importers to snapshots, transitively.
- Each dependency counts by the name it is installed under and by what it resolves to. So two aliases swapping targets re-key.
- Each package counts by name, version **and resolved peers**: `foo@1(react@18)` is not `foo@1(react@19)`.
- Under `nodeLinker: hoisted` in `pnpm-workspace.yaml`, or `node-linker=hoisted` in `.npmrc`, it counts every variant of `foo@1`. That install keeps one copy per version and ignores the variants.
- So there, a's react bump re-keys b when both reach `foo@1`.
- A linker set on the command line, in the environment or in a user `.npmrc` is not seen.
- Each package also counts by its resolution and the `patchedDependencies` entry pnpm applies to it.
- That entry is keyed `name@version`, a version range such as `name@<=7.0.0`, or `name`, in that precedence.
- A `link:` hashes the linked importer's reach.
- A link to an importer's `publishDirectory` is that importer: its edge and reach, not the directory's content. `publishConfig.linkDirectory` writes such a link: `link:../b/dist`.
- A `link:` to a directory that is no importer hashes the directory's content. That is an importer's link or, under an override, a package's.
- Under `excludeLinksFromLockfile`, which leaves links out of the file, it hashes the directory a `package.json` `link:` names. That goes in every project's key, as the importers' reaches do.
- A `file:` directory dependency hashes its own closure. v9 keys it `name@file:…`, v5/v6 by the bare `file:…`.
- It also hashes the directory's content, minus its `node_modules` and `.git`: pnpm copies it at install and records only its path. So an edit in it re-keys the projects reaching it.
- That is unless the directory is an importer's. An injected workspace package is an edge (see Project edges): its directory's build output re-keys nothing.
- The copy's content does count, where the dependant finds it: its own `node_modules/<name>`, then the root's under `nodeLinker: hoisted`.
- So a copy `pnpm install` re-synced re-keys only the projects reaching it.
- `overrides` and the catalogs count through their effect: the snapshot an importer reaches.
- Every other top-level field goes into every project, with the lockfile version.
- Those fields are `settings`, `packageExtensionsChecksum`, `pnpmfileChecksum`, `ignoredOptionalDependencies`, v6's `onlyBuiltDependencies`, and any field pnpm adds later.
- A multi-document lockfile reads its last document as the lockfile. It hashes the ones before it into every project.
- pnpm 10.x and 11 write such a file: the env lockfile (`configDependencies`, the package manager's own install) comes ahead of the project's.
- v13 (`lockfile.format: v13`, pnpm 12.20+) writes no peer suffix. One entry per `name@version` lists its peers.
- `pnpm()` resolves each v13 peer from the dependant's scope, as pnpm installs it. That includes a peer its own dependency asks for (`below`).
- So a v13 file keys each project exactly as the same workspace's v9 file.
- Its `settings`' `overrides`, `catalogs` and `patchedDependencies` are read per project, as v9's top-level ones.
- A CRLF file reads as its LF form, `settings` and `ignoredOptionalDependencies` included.
- A workspace's own `version` is not in pnpm-lock.yaml (`link:../b`). So a bump of it re-keys only that workspace.
- It does not re-key the projects whose `pnpm pack` writes it in place of a `workspace:` range. Give such a task the dependency's `package.json` in `inputs.workspaceFiles`.

</details>

<details><summary>bun details</summary>

The file is `bun.lock`.

- A `bun.lockb` alone is refused, since it is binary. The refusal names `bun install --save-text-lockfile`, which writes `bun.lock`.
- It follows Bun's hoisted layout. A dependency `d` of the package at path `p` is `p/d` when that key exists, else the nearest ancestor's, else the root's.
- So a nested version counts for the package it is nested under, and no other.
- A workspace resolves from its own name, or from `./<name>` when a root package holds that name. Bun nests that workspace's own dependencies there.
- A peer reaches every installed copy of its name. A peer is a `peerDependencies` entry installed under no other field, of a package or a workspace.
- That is because Bun's isolated linker links a peer from its store, not by that walk. It is the default for a workspace whose bun.lock says `configVersion: 1`.
- These hash the linked package's reach, and each is its project edge: `workspace:` entries, the root package's `name@root:`, and a `link:` to a workspace's directory.
- Such a `link:` (`b@link:./packages/b`) symlinks the workspace.
- A workspace's own `version` (not the root's) counts with it: `bun pm pack` and `bun publish` write it in place of a dependent's `workspace:` range.
- So a version bump re-keys the workspace and the projects linking it.
- Each `patchedDependencies` entry, and the content of its patch file, counts with the package it patches. bun.lock records only the path.
- So a patch edit re-keys only the projects reaching it.
- A `file:` directory dependency counts with the directory's content, as under pnpm. So does a `link:` to a directory that is no workspace.
- Bun copies the first and links the second, recording only the path.
- A `bun link` link (`gdep@link:gdep`, a name, not a path) counts with the content its `node_modules/gdep` symlink points at in Bun's global store.
- That symlink is at the root, or under each workspace asking for it.
- `workspaces`, `packages`, the catalogs, `overrides` and `patchedDependencies` count through the packages they reach.
- Every other top-level field goes into every project: `trustedDependencies`, and any field Bun adds later.
- Its keys are sorted, so the order Bun writes them in moves nothing. A patch naming no entry goes into every project too.
- A catalog bump reaches only the projects whose `catalog:` dependency resolves anew, through the `packages` entry it installs.

</details>

<details><summary>npm details</summary>

The file is `npm-shrinkwrap.json` when present, as npm reads it, else `package-lock.json`. It takes lockfileVersion 2 and 3.

- Each package counts by version and integrity.
- Its `resolved` URL counts only where it has no integrity (a git or tarball dependency). So a registry mirror move re-keys nothing.
- It walks the `packages` map: `p/node_modules/d`, then each ancestor directory's, then `node_modules/d`.
- A workspace nested in another's directory resolves through the outer one's `node_modules`, as Node does.
- A `link: true` entry hashes its target workspace's reach.
- A link to a `file:` directory hashes the directory's content, as under pnpm, since npm links it.
- Such a link is an entry outside the root's `workspaces` globs (`!` exclusions honoured), or any entry outside `node_modules` when the root names none.
- So does an entry npm copied from a directory: `install-links=true` writes `resolved: "file:…"` with no integrity.
- Root `overrides` reach a project through the entries they force. npm 10 does not write them to the lockfile.
- The root's own `version` is its package.json's, not an install, and is not in the key.
- A workspace's `version` is in the key, with that workspace: `npm pack` and `npm publish` write it in place of a dependent's range to it.
- So a version bump re-keys the workspace and the projects linking it.
- Version 1 (npm 6) has no `packages` map and is refused. So is a later version whose packages are only in the legacy `dependencies` tree.
- The `lockfileVersion` is in every project's digest.
- So moving between 2 and 3 (`npm install --lockfile-version 3`) re-keys every project, and `--affected` selects them all, though nothing installed changed.

</details>

<details><summary>yarn details</summary>

The file is `yarn.lock`. Berry is yarn 2+; classic is yarn 1.

- Berry resolves `name@npm:range` descriptors to entries, workspaces included.
- Each entry hashes every field, its dependency lists included.
- So the root workspace's `dependenciesMeta` reaches every project, and two aliases swapping targets re-key.
- `__metadata`'s `version` and `cacheKey` go into every project.
- Berry records every workspace as `0.0.0-use.local`. So, as under pnpm, a workspace's own version bump re-keys no dependent.
- A Yarn 4 catalog dependency (`catalog:`, `catalog:<name>`) is recorded as that literal. Its range lives in `.yarnrc.yml`.
- So the digest reads the range there and reaches the entry it keys.
- A catalog `.yarnrc.yml` does not name, or a range the file does not key, reaches every entry of its package. A bump of any of them re-keys the workspace.
- So does a descriptor the file does not key, as when a root `resolutions` override rewrote it to another range.
- There the entry installed in its place is reached through the package's name. So changing it re-keys the workspaces that depend on it.
- A path range (`portal:`, `file:`, `link:`) reaches the entry keyed to the package naming it (`::locator=…`), not another workspace's of the same name.
- A `portal:` or `link:` to a workspace reaches that workspace's closure, as `workspace:` does. Yarn symlinks the workspace itself, and its entry lists no dependencies.
- A `portal:` or `link:` to a directory that is no workspace also hashes the directory's content. Yarn symlinks it and records no hash.
- That holds for one a `portal:` or `file:` package names too; its path is relative to that package's directory.
- Berry's `file:` carries its own `::hash=`.
- Every `patch:` entry is reached by the plain descriptor it patches.
- That covers Yarn's builtin compat patches (`resolve`, `typescript`, `fsevents`), in Yarn 2/3's spelling (`resolve@^1.22.0`) and in Yarn 4's (`resolve@npm%3A^1.22.0`).
- It also covers a root `resolutions` patch over a descriptor the file still keys (what `yarn patch-commit -s` writes).
- The workspace asks for the plain descriptor, and the patched entry is the one Yarn installs. So adding or editing the patch re-keys it.
- A `packageExtensions` dependency is installed for each matching package that does not declare it, yet its lockfile entry lists none. `yarn()` adds the edge.
- That covers `.yarnrc.yml`'s extensions and every one Yarn's builtin list adds, as Yarn 2.4 through 4.18 ship it.
- The builtin list holds `@babel/parser` → `@babel/types`, `winston-transport` → `logform`, `terser` → `acorn` and some eighty more.
- So a lockfile-only bump of the added package re-keys the packages that reach the extended one.
- An entry no workspace reaches (an extension it cannot read) re-keys every project.
- `yarn()` owns `.yarnrc.yml` and hashes it into every task, its catalogs aside (see Install settings).
- Classic records no workspaces. So it yields one digest for the root that every project hashes: coarse, and honest about what the file records.
- Classic gives no project edges (see Project edges).
- A classic `file:` directory, which classic copies with no hash, hashes its content into that digest. So does a `link:` one, which it symlinks.
- The exception is a `link:` to a workspace the root `workspaces` globs name: Yarn 1 links that workspace as it does by its name.
- A `!` glob does not count there: Yarn 1 takes none and links the directory anyway.

</details>

A `file:` or `link:` directory outside the repository (`"dep": "link:../../../vendor/dep"`) is hashed by its content too, under every manager.

An edit in it re-keys the projects reaching it. So does a gitignored file inside such a directory in the repository (a `dist/` the dependency builds): the manager copies or links it.

Git lists no change to either. So `--affected` compares each directory's hash with the one `vx lock` recorded at the base, and selects the projects reaching one that moved.

The run hashes each directory once, for selection and key alike.

A project the lockfile has no entry for hashes the digest of the nearest package that encloses it, with the root's.

For example, `packages/a/e2e` resolves from `packages/a/node_modules` first. Outside every package, a project hashes the root's digest alone: the only `node_modules` it can resolve from.

Some things are in no closure, so you name them yourself:

- A phantom dependency: one the project imports but neither it nor the root declares, such as a sibling's package hoisted to the root. Declare it.
- A patch a `postinstall` script applies (`patch-package`). No lockfile records it, so name the patches in `inputs.workspaceFiles` (`patches/**`).

  Run the install after a pull that changes a patch. No record says which patch `node_modules` holds, so a run before the install builds against the old patch under the new one's key.

- A file an install script writes: `prisma generate`'s client, a native addon node-gyp builds.

  Name it in `inputs.files` (under the project's `node_modules`) or `inputs.workspaceFiles` (under the root's: `node_modules/.prisma/client/**`). A path named outright is keyed though git ignores it.

A lockfile the parser cannot read **refuses the run**. The refusal names the file, the reason and the install that regenerates it.

This is on purpose. The alternative is keying on nothing, and a key that is missing material is a stale hit waiting to happen.

Under `--affected` the refusal also says which side could not be read: the working tree's copy, or the one at the base ref.

A lockfile-migration commit hits the base side, where no install helps. The refusal then says to name another base (`--affected=<ref>`).

These are refused the same way:

- A lockfile holding git merge conflict markers. It names two installs at once, and yarn classic's format parsed one side of it without a word.
- A `pnpm-lock.yaml` whose importer or package names a dependency it has no entry for: `snapshots` in v9, `packages` in v5/v6. A `link:` needs none.

  pnpm refuses it too ("Broken lockfile"). Read as a leaf, that package's own dependencies would be in no key.

- A `pnpm-lock.yaml` or berry `yarn.lock` cut short: an entry, or its `dependencies`, that is not a mapping. Read as an entry with no dependencies, it left everything below it out of the key.

### The installed tree

vx refuses to run when `node_modules` is not the install your lockfile names. It tells you which install fixes it:

```
node_modules was installed from a different bun.lock (packages/ui's is-number is 7.0.0, the lockfile names 5.0.0) — run `bun install`
```

The key hashes the lockfile, never `node_modules`. Say a `git pull` brings a lockfile change, and you run before the install.

The run would build against the old packages and save the output under the new lockfile's key. After the install that output would replay, to teammates too through a remote cache.

So a run whose cached tasks key on the lockfile **refuses while `node_modules` is not the install the lockfile names**. It reads the record each manager leaves of its install:

- npm: `node_modules/.package-lock.json`, each installed path's version. Under `install-strategy=linked` it reads them from `node_modules/.store`.
- pnpm: `node_modules/.pnpm/lock.yaml`, each importer's links and the packages they reach.

  `pnpm add`, `update` and `remove` leave the package they replaced in it until a plain `pnpm install`. That leftover counts for nothing.

- Yarn 1: `node_modules/.yarn-integrity`.
- Yarn 2+: `node_modules/.yarn-state.yml`. It reads each package installed, then each workspace it lists: its registry dependencies' versions where Node resolves them.

  For a dependency the lockfile resolves to a `patch:` entry, it reads the locator installed there. So a pull that adds a patch refuses too.

- Yarn 2+ under `nodeLinker: pnpm`: also its `node_modules/.store`, a directory per package, named by its locator's hash.
- Bun 1.4 leaves no record, so `bun()` reads the installed packages themselves (below).

<details><summary>Details</summary>

Under `bun()`, it reads each installed package's `package.json`:

- each workspace's registry dependencies, where Node resolves them: its own `node_modules`, then up to the root's;
- then every registry package bun.lock lists, where the linker put it. So a pull that bumps only a transitive version refuses too.
- Under the hoisted linker, the key `p/d` sits at `node_modules/p/node_modules/d`. A package's bundled dependencies, which its tarball ships, are left aside.
- Under the isolated linker, it reads the store (`node_modules/.bun/<name>@<version>/node_modules`) as Node walks it from the workspaces' links.
- There each copy's dependency must be linked to the version the lockfile resolves. Bun never prunes the store, so a copy no link reaches is not read.

A patch edit moves no byte of bun.lock, which names the patch by path. So `bun()` also reads the `.bun-tag-<hash>` Bun 1.4.4 leaves in each copy it patched.

The tag is the patch file's SHA-1: its first 8 bytes as a little-endian number, in hex.

- A copy with no tag where bun.lock names a patch (a pull that adds one) refuses.
- So does a copy tagged for another version of the patch.
- A tagged copy bun.lock names no patch for refuses too, naming `bun install --force`. After a pull that removes a patch, `bun install` keeps the patched copy.
- A copy whose directory cannot be listed is said, not refused.

npm's record is checked against the tree too. `npm install --dry-run` (npm 10.9) rewrites the record to the new lockfile and installs nothing.

So a package the record lists that the tree lacks, or holds at another version, refuses.

Only what the install put there counts:

- a package the lockfile does not list, or names at another version;
- a missing package the install should hold.

The install should hold:

- under npm, a production dependency of a package or workspace installed; of the root's own once every workspace is;
- under pnpm, a production dependency of an importer installed;
- under Yarn 1, any entry, unless the install recorded `--production` (or `--focus`).

So a `--omit=dev` / `--prod` / `--production` install passes. So does a filtered one (`npm install -w`, `pnpm --filter`), and a pull that adds a workspace the filter never installed.

Not checked:

- a workspace with no root `node_modules` (a fresh clone). Nothing installed can be wrong, and a task that needs a package fails, which saves nothing;
- a package Yarn 2+ left out. Only an extra counts there, since a platform's optional package is left out too;
- Yarn's PnP linker;
- an install by a manager whose record is absent;
- under `bun()`, a package not from the registry (`file:`, git, a tarball). Its copy's patch tag is still checked when bun.lock patches it, under either linker;
- under `bun()`, a package the hoisted tree lacks: another platform's optional package, a `--production` install.

The answer is a pure function of the files compared. So a match is kept in the cache dir (`vx-lockfile-installed-*.json`) under their stat identities.

A warm run stats them and compares nothing. A changed lockfile compares all again.

Under `bun()` the stat identities are the root's and each workspace's `node_modules` directory, which a relink or a replaced package moves, and each patch file.

A run that parsed a changed lockfile for its key compares from that parse, not a second one.

</details>

## Install settings

Some files change the install without changing the lockfile. Each plugin hashes them into every task.

For example, pnpm's `node-linker`, bun's `linker = "isolated"`, a registry in `.npmrc` or Yarn's `nodeLinker` lays `node_modules` out anew under a byte-identical lockfile.

Each plugin owns its manager's files and hashes each present file whole into every task. A change to one selects every project under `--affected`:

| Plugin   | Settings                                                                                                                                                                                     |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm()` | `pnpm-workspace.yaml`, `.npmrc`, the root manifest's `pnpm` field (`package.json`, `package.json5` or `package.yaml`)                                                                        |
| `bun()`  | `bunfig.toml`, `.npmrc`                                                                                                                                                                      |
| `npm()`  | `.npmrc`                                                                                                                                                                                     |
| `yarn()` | `.yarnrc.yml`, `.yarnrc` and `.npmrc` (yarn 1), the root `package.json`'s `workspaces.nohoist`, `installConfig`, `resolutions`, `dependencies`, `devDependencies` and `optionalDependencies` |

A file has one owner. So two of these plugins that share a settings file cannot be declared together: `pnpm()` and `bun()` both own `.npmrc`.

<details><summary>Details</summary>

`pnpm()` hashes `pnpm-workspace.yaml` without the fields the lockfile records per project.

pnpm 10+ keeps those fields there: `patchedDependencies`, `overrides`, `packageExtensions`, `ignoredOptionalDependencies`, `catalog` and `catalogs`.

So a patch, an override, an extension or a catalog bump re-keys only the projects that reach the package it changes. `--affected` selects them through the lockfile.

Any other setting in the file re-keys every project. A file that does not parse is hashed whole.

From the root manifest (`package.json`, `package.json5` or `package.yaml`) it adds only the `pnpm` field: `onlyBuiltDependencies` and the rest pnpm reads there and the lockfile does not record.

The field's `overrides`, `packageExtensions` and `patchedDependencies` are left aside. A root dependency edit is the lockfile's.

`yarn()` hashes `.yarnrc.yml` without `catalog` and `catalogs`. The digest resolves each workspace's `catalog:` range through them to the yarn.lock entry it names.

So a catalog bump re-keys only the projects that reach the package.

Under `--affected` a catalog edit still selects every project: the base side's digest reads the working tree's `.yarnrc.yml`.

`yarn()` reads the root `package.json`'s `resolutions`, because yarn.lock does not record where one applies.

A parent-scoped one (`"is-odd/is-number"`) leaves the parent's entry on the range it declares.

So adding one whose range another package already keys changes the install under a byte-identical yarn.lock.

Berry's overrides also become edges. Each entry a `resolutions` key reaches gets an edge to the entry the override's range names.

A key reaches any entry depending on the name, or only the named parent's for a scoped one. A parent's range or a `**` counts as any parent.

So a lockfile-only bump of that entry (`yarn up -R is-number`) re-keys the parent's workspaces too, not only the package that keys the range itself.

An unreadable scope over-keys, never under-keys.

`yarn()` reads the root's `dependencies`, `devDependencies` and `optionalDependencies` because yarn 1's lockfile records no importer, only the ranges asked.

Moving a range between the root and a workspace (root `is-number` `^6` → `^7`, `packages/a` `^7` → `^6`) leaves yarn.lock byte-identical.

Yet it moves the root `node_modules` copy that every project without its own resolves.

Any change to them re-keys every project and selects every project under `--affected`. Berry records them on the root workspace's entry, which every project's digest already includes.

For the same reason a yarn 1 key reads every workspace's `package.json`. Say `packages/a` moves `is-number` `^6` → `^7` beside `packages/b`'s `^7`.

yarn.lock stays byte-identical, yet `a`, and every project linking `a`, resolves 7.0.0.

So any edit to a workspace manifest re-keys every project and selects every project under `--affected`, since a yarn 1 key covers the whole workspace.

</details>

## The manifest as an input

Each task's inputs include its project's manifest, so an edit to `package.json` re-keys that project's tasks.

Every task with `inputs` of a project the lockfile lists, cached or not, gets its literal manifest appended to `inputs.files` (the `project` stage).

Through `^` keys, the edit also re-keys its dependants.

The manifest is `package.json`. Under `pnpm()` it is `package.json5` or `package.yaml` where the package has no `package.json`, as pnpm reads them (one stat per project a run).

A task with no `inputs` stays keyless. One whose inputs already name its manifest is left alone.

A task that rewrites its own `package.json` with the same bytes (tsdown) keeps its hits under `inputs.stability: { strategy: 'mutable' }`.

## Project edges

`discover` gives vx each project's edges as the lockfile records them. If `app` depends on the workspace package `ui`, `app#build` runs after `ui#build` under `^build`.

A member a committed `.gitignore` ignores, with a manifest git does not track, is no project.

The manager installs it, but no clone has it, so the lock leaves it out. Track its manifest, or unignore it, to make it one.

The edges are read from the same memo as the digests. There are these kinds:

- **deps** order `^task` and reach `--filter …` and `--affected`. A dep is a dependency the lockfile resolves to a workspace package:
  - pnpm `link:`;
  - under pnpm's `excludeLinksFromLockfile`, which leaves every `link:` dependency out of the file, a `package.json` `link:` to a workspace package.

    The file then no longer says who links whom. So every project's key holds every importer's reach, and a `link:` the file leaves out is no stale lockfile.

  - pnpm `file:` to an injected workspace package's directory: `dependenciesMeta.<name>.injected`, or `injectWorkspacePackages` with `dedupeInjectedDeps: false`.

    The dependant waits for the package's build. It reads pnpm's copy in `node_modules/.pnpm`, which pnpm re-syncs at install, not after a build vx runs.

    So the copy's content is in the dependant's key. Run `pnpm install` after building the injected package, or do not inject it.

    Otherwise the dependant builds against the old copy, keyed as that copy.

  - bun's `workspace:` entries: a `workspace:` path or alias, and an `npm:` alias Bun links to the workspace package, by the spec it records;
  - bun's `link:` entries to a workspace's directory;
  - npm's `link: true` entries;
  - yarn berry's workspace entries and `link:` / `portal:` paths.

- **peers**: a peer with no installed entry of the same name, resolving to a workspace package, orders the build too.

  If it would close a cycle through the order edges, it is reach only. Projects go in name order, so the edge kept is stable.

  pnpm records an auto-installed peer under `dependencies`, so `pnpm()` asks the project's `package.json` which of those entries are peers.

  yarn berry resolves a peer to the workspace of its name, which Yarn hoists.

- **workspace packages installed through a package**: a registry package's dependency the install resolved to a workspace package.

  npm and bun link `node_modules/is-number` to `packages/b` when the workspace satisfies `is-odd`'s range. Yarn's transparent workspaces do the same.

  A pnpm `overrides` to `workspace:*` writes `link:` into the package's snapshot.

  The project loads that workspace package as surely as its own dependency. So it builds after it, and its key holds that package's, as a peer's would.

  If that would close a cycle through the order edges, it is reach only.

  Read from each project's own dependencies alone, an edit to such a package would re-key only that package. `--affected` would leave out the projects reaching it, and they would hit with its old build.

  Under yarn, only descriptors the file keys count, as for a direct link.

- **the root's workspace packages**: a workspace package the root depends on is the root project's dependency, and no other project's.

  It is installed at the root `node_modules`, so Node resolves it for every project. But that declares nothing.

  A project that reads it names it in its own `package.json`. Otherwise the package neither orders its build, nor moves its key, nor selects it under `--affected`.

- Each importer with a manifest is a project. The manifest is `package.json`, or under `pnpm()` a `package.json5` or `package.yaml`, which pnpm reads and records like any other.

  One with no vx config joins as a project a plugin added. Its tasks come from the `project` stage, else the default `build`.

  The root importer is the exception: it is a project only by its own vx config.

  An importer with no manifest, and an edge to one, is skipped, unless core already has a project there (a sparse checkout left it out).

  Then the edge stands, so a run of a dependant is refused for it rather than run or hit without it.

  A project is named by its manifest's `name`, unless its config names it or another importer's manifest shares the name. Then its path names it.

  The workspace globs match a directory holding any of the manifests the manager reads.

- A yarn classic (v1) lockfile records no workspaces. So `yarn()` reads them as Yarn 1 does: the directories the root `package.json` `workspaces` globs name.

  Those globs are an array or `{ packages }`.

  A dependency on a workspace's name is a link, unless the lockfile keys its descriptor. Yarn 1 writes that only for the registry copy it fetched because the workspace's version missed the range.

  A `link:` to a workspace's directory is a link whatever name it is under.

  A root `resolutions` entry that names the package everywhere (`ms`, `**/ms`) replaces the range first, as Yarn 1 does.

- A lockfile older than the manifests **refuses `vx lock`**, naming the install that refreshes it. It is older when the file lacks:
  - an importer for a workspace the globs name, such as a renamed folder;
  - a `dependencies`, `devDependencies` or `optionalDependencies` entry naming a workspace package, for that importer.

  The globs are the root `package.json` `workspaces`, or `pnpm-workspace.yaml` under `pnpm()`. `!` exclusions are honoured as the manager reads them.

  A trailing `**` matches zero directories: `!**/fixtures/**` leaves out `packages/fixtures`.

  An entry pnpm leaves out by design does not count: an optional dependency its `ignoredOptionalDependencies` names.

  Either case would lose edges: the package would build beside what it depends on and hit with old content.

  It also refuses a dependency, still in a manifest, that the file resolves to a workspace no longer on disk (`rm -rf packages/k` while `packages/l` names `k`).

  The install fails and leaves the file as it was, so the refusal names the dependency to remove:

  ```
  bun.lock is out of date: packages/l depends on the workspace k (packages/k), which is not on disk
  ```

  Yarn classic is exempt: its edges come from the manifests.

  Under `bun()` a `package.json` with no `name` (build output's `{"type":"module"}`) is no workspace, as Bun leaves it out of `bun.lock`.

- `pnpm()` reads the root `pnpm-lock.yaml` only.

  With `shared-workspace-lockfile` false, pnpm writes a lockfile per package and the root's lists none of them. So `vx lock` refuses, naming the setting: an install would not fix it.

  The setting is `sharedWorkspaceLockfile: false` in `pnpm-workspace.yaml`, which pnpm 10.8+ reads first, or the one in `.npmrc`.

A workspace manifest that does not parse **refuses `vx lock`**, under every manager. It names the manifest and, for JSON, the line and column.

Not parsing means git merge conflict markers, a syntax error, or JSON, JSON5 or YAML that is not an object.

A directory holding two manifests (a `package.json` and a `package.yaml`) is refused too: pnpm 10.28 lists the package by one and installs the other's dependencies.

Read as no manifest, such a package would lose its dependencies, and its dependents would hit with old bytes.

`bun()` reads a manifest as Bun does, so a trailing comma or a comment is no syntax error there. npm, pnpm and yarn refuse both, and so do their plugins.

These edges are what was installed. So they differ from a guess over manifest ranges where the manager decided otherwise:

- pnpm installs a plain range (`^2.0.0`, `*`, `catalog:`) from the registry unless it is `workspace:`;
- yarn packs a `file:` directory as a copy. That is no edge: Yarn neither links nor re-syncs it;
- bun installs `dependencies` over a devDependency of the same key.

They are the only package edges vx has: core reads none from a `package.json`.

So a workspace whose tasks use `^build` declares one of these plugins, or another that returns `deps`. Without one, vx refuses the `^`, naming the fix.

A dependency an install adds or removes reaches `--affected` as this lockfile's change.

## Cost

A warm run pays one read, one hash and one row read for the lockfile, never a parse.

<details><summary>Details</summary>

Core's `lockfileClaim` owns the file, the per-project key, the memo and the `--affected` diff. This package is the parsers.

The parsers are internal. The package exports `pnpm`, `bun`, `npm`, `yarn` and `LockfileOptions`.

A run keys each project from its digest in `.vx/dependencies.lock`. Core holds that record to what this plugin derives from the lockfile now, through the memo below.

The exception is a file the lockfile names that moved since the record, as above.

The rest is parsed **once per content**: each importer's edges and the dependency names it records, and the digests `vx lock` asks for.

The edges include pnpm's `excludeLinksFromLockfile` and `ignoredOptionalDependencies`, so a warm `discover` reads no lockfile text.

They are memoised in core's cache.db (`lockfile_memos`, one row per file and claimant), by the file's xxh3 and the plugin.

The plugin part includes its parsers' source and what core's digest step answers on a fixed probe graph. So an upgrade that changes how a digest is built never replays an old digest.

`vx lock` writes the digests' row, so the run after it parses nothing. A lockfile changed since costs one parse.

`--affected` reads which files the lockfile names from the same memo.

Under `scope: 'workspace'` the file is parsed for its edges alone, once per content. So an unreadable lockfile is refused there too.

The settings files are read once per run.

The digest is one hash per strongly connected component of the dependency graph (lockfiles carry cycles), children first.

So a 1000-importer / 3000-package lockfile digests in ~20 ms when it does change.

</details>

## `--affected`

After a lockfile change, `vx run test --affected=origin/main` selects only the projects whose digest moved.

With a plugin declared at `scope: 'project'`, core hands it the lockfile at the base ref and in the working tree. It digests both and names the projects whose digest moved.

At `scope: 'workspace'` a change still selects every project.

A lockfile that appeared or was deleted selects everything: every project's `node_modules` is in question.

A change to a file the lockfile names but does not pin selects the projects reaching it, even inside another project's directory.

Such a file is a `file:`, `link:` or `portal:` directory, or a patch.

## Testing

`bun test` covers:

- each parser's digests: transitive bumps, nested versions, workspace links, peer suffixes, patches, install-wide knobs, cycles, key order, aliases, refusals;
- `discover`'s edges per manager (`discover.test.ts`);
- the edges core's manifest graph read over the same real installs, recorded when core stopped reading them (`discover-parity.test.ts`);
- the settings files each plugin owns;
- `vx run`, `vx why` and `--affected` end to end.

vx's own repository declares `bun()`.
