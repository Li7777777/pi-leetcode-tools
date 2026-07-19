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
