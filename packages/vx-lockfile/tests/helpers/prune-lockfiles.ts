// Lockfiles the package managers wrote for one workspace, verbatim: root
// devDependency is-number@^2; `a` → is-odd@3.0.1 (→ is-number@^6) and the
// workspace package `b`; `b` → is-number@^7; `c` → is-number@^4 and
// left-pad@1.3.0. Pruned to `a`, `c`'s entries go and nothing else does.

/** Written by bun 1.4.2. */
export const BUN_LOCK = `{
  "lockfileVersion": 2,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "root",
      "devDependencies": {
        "is-number": "^2.0.0",
      },
    },
    "packages/a": {
      "name": "a",
      "version": "1.0.0",
      "dependencies": {
        "b": "workspace:*",
        "is-odd": "3.0.1",
      },
    },
    "packages/b": {
      "name": "b",
      "version": "1.0.0",
      "dependencies": {
        "is-number": "^7.0.0",
      },
    },
    "packages/c": {
      "name": "c",
      "version": "1.0.0",
      "dependencies": {
        "is-number": "^4.0.0",
        "left-pad": "1.3.0",
      },
    },
  },
  "packages": {
    "a": ["a@workspace:packages/a"],

    "b": ["b@workspace:packages/b"],

    "c": ["c@workspace:packages/c"],

    "is-buffer": ["is-buffer@1.1.6", "", {}, "sha512-NcdALwpXkTm5Zvvbk7owOUSvVvBKDgKP5/ewfXEznmQFfs4ZRmanOeKBTjRVjka3QFoN6XJ+9F3USqfHqTaU5w=="],

    "is-number": ["is-number@2.1.0", "", { "dependencies": { "kind-of": "^3.0.2" } }, "sha512-QUzH43Gfb9+5yckcrSA0VBDwEtDUchrk4F6tfJZQuNzDJbEDB9cZNzSfXGQ1jqmdDY/kl41lUOWM9syA8z8jlg=="],

    "is-odd": ["is-odd@3.0.1", "", { "dependencies": { "is-number": "^6.0.0" } }, "sha512-CQpnWPrDwmP1+SMHXZhtLtJv90yiyVfluGsX5iNCVkrhQtU3TQHsUWPG9wkdk9Lgd5yNpAg9jQEo90CBaXgWMA=="],

    "kind-of": ["kind-of@3.2.2", "", { "dependencies": { "is-buffer": "^1.1.5" } }, "sha512-NOW9QQXMoZGg/oqnVNoNTTIFEIid1627WCffUBJEdMxYApq7mNE7CpzucIPc+ZQg25Phej7IJSmX3hO+oblOtQ=="],

    "left-pad": ["left-pad@1.3.0", "", {}, "sha512-XI5MPzVNApjAyhQzphX8BkmKsKUxD4LdyK24iZeQGinBN9yTQT3bFlCBy/aVx2HrNcqQGsdot8ghrjyrvMCoEA=="],

    "b/is-number": ["is-number@7.0.0", "", {}, "sha512-41Cifkg6e8TylSpdtTpeLVMqvSBEVzTttHvERD741+pnZ8ANv0004MRL43QKPDlK9cGvNp6NZWZUBlbGXYxxng=="],

    "c/is-number": ["is-number@4.0.0", "", {}, "sha512-rSklcAIlf1OmFdyAqbnWTLVelsQ58uvZ66S/ZyawjWqIviTWCjg2PzVGw8WUA+nNuPTqb4wgA+NszrJ+08LlgQ=="],

    "is-odd/is-number": ["is-number@6.0.0", "", {}, "sha512-Wu1VHeILBK8KAWJUAiSZQX94GmOE45Rg6/538fKwiloUu21KncEkYGPqob2oSZ5mUT73vLGrHQjKw3KMPwfDzg=="],
  }
}
`

/** Written by pnpm 10.28.0. */
export const PNPM_LOCK = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    devDependencies:
      is-number:
        specifier: ^2.0.0
        version: 2.1.0

  packages/a:
    dependencies:
      b:
        specifier: workspace:*
        version: link:../b
      is-odd:
        specifier: 3.0.1
        version: 3.0.1

  packages/b:
    dependencies:
      is-number:
        specifier: ^7.0.0
        version: 7.0.0

  packages/c:
    dependencies:
      is-number:
        specifier: ^4.0.0
        version: 4.0.0
      left-pad:
        specifier: 1.3.0
        version: 1.3.0

packages:

  is-buffer@1.1.6:
    resolution: {integrity: sha512-NcdALwpXkTm5Zvvbk7owOUSvVvBKDgKP5/ewfXEznmQFfs4ZRmanOeKBTjRVjka3QFoN6XJ+9F3USqfHqTaU5w==}

  is-number@2.1.0:
    resolution: {integrity: sha512-QUzH43Gfb9+5yckcrSA0VBDwEtDUchrk4F6tfJZQuNzDJbEDB9cZNzSfXGQ1jqmdDY/kl41lUOWM9syA8z8jlg==}
    engines: {node: '>=0.10.0'}

  is-number@4.0.0:
    resolution: {integrity: sha512-rSklcAIlf1OmFdyAqbnWTLVelsQ58uvZ66S/ZyawjWqIviTWCjg2PzVGw8WUA+nNuPTqb4wgA+NszrJ+08LlgQ==}
    engines: {node: '>=0.10.0'}

  is-number@6.0.0:
    resolution: {integrity: sha512-Wu1VHeILBK8KAWJUAiSZQX94GmOE45Rg6/538fKwiloUu21KncEkYGPqob2oSZ5mUT73vLGrHQjKw3KMPwfDzg==}
    engines: {node: '>=0.10.0'}

  is-number@7.0.0:
    resolution: {integrity: sha512-41Cifkg6e8TylSpdtTpeLVMqvSBEVzTttHvERD741+pnZ8ANv0004MRL43QKPDlK9cGvNp6NZWZUBlbGXYxxng==}
    engines: {node: '>=0.12.0'}

  is-odd@3.0.1:
    resolution: {integrity: sha512-CQpnWPrDwmP1+SMHXZhtLtJv90yiyVfluGsX5iNCVkrhQtU3TQHsUWPG9wkdk9Lgd5yNpAg9jQEo90CBaXgWMA==}
    engines: {node: '>=4'}

  kind-of@3.2.2:
    resolution: {integrity: sha512-NOW9QQXMoZGg/oqnVNoNTTIFEIid1627WCffUBJEdMxYApq7mNE7CpzucIPc+ZQg25Phej7IJSmX3hO+oblOtQ==}
    engines: {node: '>=0.10.0'}

  left-pad@1.3.0:
    resolution: {integrity: sha512-XI5MPzVNApjAyhQzphX8BkmKsKUxD4LdyK24iZeQGinBN9yTQT3bFlCBy/aVx2HrNcqQGsdot8ghrjyrvMCoEA==}
    deprecated: use String.prototype.padStart()

snapshots:

  is-buffer@1.1.6: {}

  is-number@2.1.0:
    dependencies:
      kind-of: 3.2.2

  is-number@4.0.0: {}

  is-number@6.0.0: {}

  is-number@7.0.0: {}

  is-odd@3.0.1:
    dependencies:
      is-number: 6.0.0

  kind-of@3.2.2:
    dependencies:
      is-buffer: 1.1.6

  left-pad@1.3.0: {}
`

/** Written by npm 10.9.4. */
export const NPM_LOCK = `{
  "name": "root",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": {
      "name": "root",
      "workspaces": [
        "packages/*"
      ],
      "devDependencies": {
        "is-number": "^2.0.0"
      }
    },
    "node_modules/a": {
      "resolved": "packages/a",
      "link": true
    },
    "node_modules/b": {
      "resolved": "packages/b",
      "link": true
    },
    "node_modules/c": {
      "resolved": "packages/c",
      "link": true
    },
    "node_modules/is-buffer": {
      "version": "1.1.6",
      "resolved": "https://registry.npmjs.org/is-buffer/-/is-buffer-1.1.6.tgz",
      "integrity": "sha512-NcdALwpXkTm5Zvvbk7owOUSvVvBKDgKP5/ewfXEznmQFfs4ZRmanOeKBTjRVjka3QFoN6XJ+9F3USqfHqTaU5w==",
      "dev": true,
      "license": "MIT"
    },
    "node_modules/is-number": {
      "version": "2.1.0",
      "resolved": "https://registry.npmjs.org/is-number/-/is-number-2.1.0.tgz",
      "integrity": "sha512-QUzH43Gfb9+5yckcrSA0VBDwEtDUchrk4F6tfJZQuNzDJbEDB9cZNzSfXGQ1jqmdDY/kl41lUOWM9syA8z8jlg==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "kind-of": "^3.0.2"
      },
      "engines": {
        "node": ">=0.10.0"
      }
    },
    "node_modules/is-odd": {
      "version": "3.0.1",
      "resolved": "https://registry.npmjs.org/is-odd/-/is-odd-3.0.1.tgz",
      "integrity": "sha512-CQpnWPrDwmP1+SMHXZhtLtJv90yiyVfluGsX5iNCVkrhQtU3TQHsUWPG9wkdk9Lgd5yNpAg9jQEo90CBaXgWMA==",
      "license": "MIT",
      "dependencies": {
        "is-number": "^6.0.0"
      },
      "engines": {
        "node": ">=4"
      }
    },
    "node_modules/is-odd/node_modules/is-number": {
      "version": "6.0.0",
      "resolved": "https://registry.npmjs.org/is-number/-/is-number-6.0.0.tgz",
      "integrity": "sha512-Wu1VHeILBK8KAWJUAiSZQX94GmOE45Rg6/538fKwiloUu21KncEkYGPqob2oSZ5mUT73vLGrHQjKw3KMPwfDzg==",
      "license": "MIT",
      "engines": {
        "node": ">=0.10.0"
      }
    },
    "node_modules/kind-of": {
      "version": "3.2.2",
      "resolved": "https://registry.npmjs.org/kind-of/-/kind-of-3.2.2.tgz",
      "integrity": "sha512-NOW9QQXMoZGg/oqnVNoNTTIFEIid1627WCffUBJEdMxYApq7mNE7CpzucIPc+ZQg25Phej7IJSmX3hO+oblOtQ==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "is-buffer": "^1.1.5"
      },
      "engines": {
        "node": ">=0.10.0"
      }
    },
    "node_modules/left-pad": {
      "version": "1.3.0",
      "resolved": "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",
      "integrity": "sha512-XI5MPzVNApjAyhQzphX8BkmKsKUxD4LdyK24iZeQGinBN9yTQT3bFlCBy/aVx2HrNcqQGsdot8ghrjyrvMCoEA==",
      "deprecated": "use String.prototype.padStart()",
      "license": "WTFPL"
    },
    "packages/a": {
      "version": "1.0.0",
      "dependencies": {
        "b": "1.0.0",
        "is-odd": "3.0.1"
      }
    },
    "packages/b": {
      "version": "1.0.0",
      "dependencies": {
        "is-number": "^7.0.0"
      }
    },
    "packages/b/node_modules/is-number": {
      "version": "7.0.0",
      "resolved": "https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz",
      "integrity": "sha512-41Cifkg6e8TylSpdtTpeLVMqvSBEVzTttHvERD741+pnZ8ANv0004MRL43QKPDlK9cGvNp6NZWZUBlbGXYxxng==",
      "license": "MIT",
      "engines": {
        "node": ">=0.12.0"
      }
    },
    "packages/c": {
      "version": "1.0.0",
      "dependencies": {
        "is-number": "^4.0.0",
        "left-pad": "1.3.0"
      }
    },
    "packages/c/node_modules/is-number": {
      "version": "4.0.0",
      "resolved": "https://registry.npmjs.org/is-number/-/is-number-4.0.0.tgz",
      "integrity": "sha512-rSklcAIlf1OmFdyAqbnWTLVelsQ58uvZ66S/ZyawjWqIviTWCjg2PzVGw8WUA+nNuPTqb4wgA+NszrJ+08LlgQ==",
      "license": "MIT",
      "engines": {
        "node": ">=0.10.0"
      }
    }
  }
}
`

/** Written by yarn 1.22.22. */
export const YARN_CLASSIC_LOCK = `# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.
# yarn lockfile v1


is-buffer@^1.1.5:
  version "1.1.6"
  resolved "https://registry.yarnpkg.com/is-buffer/-/is-buffer-1.1.6.tgz#efaa2ea9daa0d7ab2ea13a97b2b8ad51fefbe8be"
  integrity sha512-NcdALwpXkTm5Zvvbk7owOUSvVvBKDgKP5/ewfXEznmQFfs4ZRmanOeKBTjRVjka3QFoN6XJ+9F3USqfHqTaU5w==

is-number@^2.0.0:
  version "2.1.0"
  resolved "https://registry.yarnpkg.com/is-number/-/is-number-2.1.0.tgz#01fcbbb393463a548f2f466cce16dece49db908f"
  integrity sha512-QUzH43Gfb9+5yckcrSA0VBDwEtDUchrk4F6tfJZQuNzDJbEDB9cZNzSfXGQ1jqmdDY/kl41lUOWM9syA8z8jlg==
  dependencies:
    kind-of "^3.0.2"

is-number@^4.0.0:
  version "4.0.0"
  resolved "https://registry.yarnpkg.com/is-number/-/is-number-4.0.0.tgz#0026e37f5454d73e356dfe6564699867c6a7f0ff"
  integrity sha512-rSklcAIlf1OmFdyAqbnWTLVelsQ58uvZ66S/ZyawjWqIviTWCjg2PzVGw8WUA+nNuPTqb4wgA+NszrJ+08LlgQ==

is-number@^6.0.0:
  version "6.0.0"
  resolved "https://registry.yarnpkg.com/is-number/-/is-number-6.0.0.tgz#e6d15ad31fc262887cccf217ae5f9316f81b1995"
  integrity sha512-Wu1VHeILBK8KAWJUAiSZQX94GmOE45Rg6/538fKwiloUu21KncEkYGPqob2oSZ5mUT73vLGrHQjKw3KMPwfDzg==

is-number@^7.0.0:
  version "7.0.0"
  resolved "https://registry.yarnpkg.com/is-number/-/is-number-7.0.0.tgz#7535345b896734d5f80c4d06c50955527a14f12b"
  integrity sha512-41Cifkg6e8TylSpdtTpeLVMqvSBEVzTttHvERD741+pnZ8ANv0004MRL43QKPDlK9cGvNp6NZWZUBlbGXYxxng==

is-odd@3.0.1:
  version "3.0.1"
  resolved "https://registry.yarnpkg.com/is-odd/-/is-odd-3.0.1.tgz#65101baf3727d728b66fa62f50cda7f2d3989601"
  integrity sha512-CQpnWPrDwmP1+SMHXZhtLtJv90yiyVfluGsX5iNCVkrhQtU3TQHsUWPG9wkdk9Lgd5yNpAg9jQEo90CBaXgWMA==
  dependencies:
    is-number "^6.0.0"

kind-of@^3.0.2:
  version "3.2.2"
  resolved "https://registry.yarnpkg.com/kind-of/-/kind-of-3.2.2.tgz#31ea21a734bab9bbb0f32466d893aea51e4a3c64"
  integrity sha512-NOW9QQXMoZGg/oqnVNoNTTIFEIid1627WCffUBJEdMxYApq7mNE7CpzucIPc+ZQg25Phej7IJSmX3hO+oblOtQ==
  dependencies:
    is-buffer "^1.1.5"

left-pad@1.3.0:
  version "1.3.0"
  resolved "https://registry.yarnpkg.com/left-pad/-/left-pad-1.3.0.tgz#5b8a3a7765dfe001261dde915589e782f8c94d1e"
  integrity sha512-XI5MPzVNApjAyhQzphX8BkmKsKUxD4LdyK24iZeQGinBN9yTQT3bFlCBy/aVx2HrNcqQGsdot8ghrjyrvMCoEA==
`

/** Written by yarn 4.5.0. */
export const YARN_BERRY_LOCK = `# This file is generated by running "yarn install" inside your project.
# Manual changes might be lost - proceed with caution!

__metadata:
  version: 8
  cacheKey: 10c0

"a@workspace:packages/a":
  version: 0.0.0-use.local
  resolution: "a@workspace:packages/a"
  dependencies:
    b: "workspace:*"
    is-odd: "npm:3.0.1"
  languageName: unknown
  linkType: soft

"b@workspace:*, b@workspace:packages/b":
  version: 0.0.0-use.local
  resolution: "b@workspace:packages/b"
  dependencies:
    is-number: "npm:^7.0.0"
  languageName: unknown
  linkType: soft

"c@workspace:packages/c":
  version: 0.0.0-use.local
  resolution: "c@workspace:packages/c"
  dependencies:
    is-number: "npm:^4.0.0"
    left-pad: "npm:1.3.0"
  languageName: unknown
  linkType: soft

"is-buffer@npm:^1.1.5":
  version: 1.1.6
  resolution: "is-buffer@npm:1.1.6"
  checksum: 10c0/ae18aa0b6e113d6c490ad1db5e8df9bdb57758382b313f5a22c9c61084875c6396d50bbf49315f5b1926d142d74dfb8d31b40d993a383e0a158b15fea7a82234
  languageName: node
  linkType: hard

"is-number@npm:^2.0.0":
  version: 2.1.0
  resolution: "is-number@npm:2.1.0"
  dependencies:
    kind-of: "npm:^3.0.2"
  checksum: 10c0/f9d2079a0dbfbce6f9f3b6644f6eb60d0211ee56bb26db3963ef4d514e2444f87e3f56c8169896c90544c501ed5e510c5b83abae6748a57d15f6ac8d85efd602
  languageName: node
  linkType: hard

"is-number@npm:^4.0.0":
  version: 4.0.0
  resolution: "is-number@npm:4.0.0"
  checksum: 10c0/bb17a331f357eb59a7f8db848086c41886715b2ea1db03f284a99d14001cda094083a5b6a7b343b5bcf410ccef668a70bc626d07bc2032cc4ab46dd264cea244
  languageName: node
  linkType: hard

"is-number@npm:^6.0.0":
  version: 6.0.0
  resolution: "is-number@npm:6.0.0"
  checksum: 10c0/5da4c68401529675c575878d2760d66f18eaef4b014858577f6003daf66488d7fe4eae684b1e8574e3fa1bb447c6c6c56b8491d2b4b3239da2d32e5f6f218008
  languageName: node
  linkType: hard

"is-number@npm:^7.0.0":
  version: 7.0.0
  resolution: "is-number@npm:7.0.0"
  checksum: 10c0/b4686d0d3053146095ccd45346461bc8e53b80aeb7671cc52a4de02dbbf7dc0d1d2a986e2fe4ae206984b4d34ef37e8b795ebc4f4295c978373e6575e295d811
  languageName: node
  linkType: hard

"is-odd@npm:3.0.1":
  version: 3.0.1
  resolution: "is-odd@npm:3.0.1"
  dependencies:
    is-number: "npm:^6.0.0"
  checksum: 10c0/89ee2e353c5a3f3bd400c79db1c307a5b3506198ee8169d521e533a9b1d8a08fc95f21a919c084e98845b4286d7ffe309778da03744dfe66c3c1763ab1a030c6
  languageName: node
  linkType: hard

"kind-of@npm:^3.0.2":
  version: 3.2.2
  resolution: "kind-of@npm:3.2.2"
  dependencies:
    is-buffer: "npm:^1.1.5"
  checksum: 10c0/7e34bc29d4b02c997f92f080de34ebb92033a96736bbb0bb2410e033a7e5ae6571f1fa37b2d7710018f95361473b816c604234197f4f203f9cf149d8ef1574d9
  languageName: node
  linkType: hard

"left-pad@npm:1.3.0":
  version: 1.3.0
  resolution: "left-pad@npm:1.3.0"
  checksum: 10c0/3fb59c76e281a2f5c810ad71dbbb8eba8b10c6cf94733dc7f27b8c516a5376cacea53543e76f6ae477d866c8954b27f1e15ca349424c2542474eb5bb1d2b6955
  languageName: node
  linkType: hard

"root@workspace:.":
  version: 0.0.0-use.local
  resolution: "root@workspace:."
  dependencies:
    is-number: "npm:^2.0.0"
  languageName: unknown
  linkType: soft
`
