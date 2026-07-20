# pi-leetcode-tools

[![npm version](https://img.shields.io/npm/v/pi-leetcode-tools?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/pi-leetcode-tools)
[![npm downloads](https://img.shields.io/npm/dm/pi-leetcode-tools?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/pi-leetcode-tools)
[![CI](https://img.shields.io/github/actions/workflow/status/Li7777777/pi-leetcode-tools/ci.yml?branch=main&style=flat-square&logo=githubactions&logoColor=white&label=CI)](https://github.com/Li7777777/pi-leetcode-tools/actions/workflows/ci.yml)
![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.19.0-339933?style=flat-square&logo=nodedotjs&logoColor=white)
[![Tests](https://img.shields.io/badge/tests-279%20passing-2ea44f?style=flat-square)](release/gate-matrix.json)
[![MCP parity](https://img.shields.io/badge/MCP%20parity-24%2F24-7c3aed?style=flat-square)](packages/pi-leetcode-tools/README.md#reference-mcp-interface-parity)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/Li7777777/pi-leetcode-tools?style=flat-square&logo=github)](https://github.com/Li7777777/pi-leetcode-tools/stargazers)
[![Last commit](https://img.shields.io/github/last-commit/Li7777777/pi-leetcode-tools?branch=main&style=flat-square&logo=git&logoColor=white)](https://github.com/Li7777777/pi-leetcode-tools/commits/main)
[![LINUX DO - Where possible begins](.github/assets/linux-do-community-badge.svg)](https://linux.do)

[简体中文](README.zh-CN.md)

Standalone source and release workspace for `pi-leetcode-tools`, an unofficial
set of native Pi tool calls for LeetCode Global and LeetCode CN.

The package source lives in `packages/pi-leetcode-tools`. This repository
contains the package, its tests, and its release infrastructure.

## Installation

```sh
pi install npm:pi-leetcode-tools@0.1.3
pi list
```

## Usage

Start a new interactive Pi session after installing or updating the package:

```sh
pi
```

The extension loads automatically. Ask Pi in natural language, or name a tool
when you want deterministic selection. For example:

```text
Use lc_daily to show today's LeetCode CN challenge.
Use lc_search to find medium array problems on LeetCode Global.
Use lc_problem to read two-sum on CN and show the C++ snippet.
Use lc_progress to summarize my CN account progress.
```

Public problem, profile, contest, and solution reads do not require a login.
Account progress, submission history, code execution, and submission do. See
the [package usage and authentication guide](packages/pi-leetcode-tools/README.md#quick-start)
for login commands, profile switching, and Pi-managed CLI paths. `lc_submit`
works only in an interactive Pi session and always requires a fresh UI
confirmation.

If the extension is installed but disabled, use `pi config` to enable its
resources and then start a new Pi session.

## Requirements

- Node.js 22.19.0 or newer
- npm

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
```

Useful release checks include:

```sh
npm run verify:tools:release-workflow
npm run verify:tools:release:no-record
```

Run `npm run pack:tools` to create and verify the publishable package artifact.

## Release model

The release workflow is fail-closed. Publishing requires reviewed policy data,
an immutable version tag, the configured npm trusted publisher, and successful
registry verification. See `release/TOOLS-BOOTSTRAP.md` and
`release/tools-release-policy.json` for the complete process.

Package-specific usage, tool inventory, and security behavior are documented
in `packages/pi-leetcode-tools/README.md`.

## License

MIT. See `LICENSE` and `NOTICE`.
