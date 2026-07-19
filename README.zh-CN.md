# pi-leetcode-tools

[![npm version](https://img.shields.io/npm/v/pi-leetcode-tools?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/pi-leetcode-tools)
[![npm downloads](https://img.shields.io/npm/dm/pi-leetcode-tools?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/pi-leetcode-tools)
[![CI](https://img.shields.io/github/actions/workflow/status/Li7777777/pi-leetcode-tools/ci.yml?branch=main&style=flat-square&logo=githubactions&logoColor=white&label=CI)](https://github.com/Li7777777/pi-leetcode-tools/actions/workflows/ci.yml)
![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.19.0-339933?style=flat-square&logo=nodedotjs&logoColor=white)
[![Tests](https://img.shields.io/badge/tests-279%20passing-2ea44f?style=flat-square)](release/gate-matrix.json)
[![MCP parity](https://img.shields.io/badge/MCP%20parity-24%2F24-7c3aed?style=flat-square)](packages/pi-leetcode-tools/README.zh-CN.md#参考-mcp-接口对齐)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/Li7777777/pi-leetcode-tools?style=flat-square&logo=github)](https://github.com/Li7777777/pi-leetcode-tools/stargazers)
[![Last commit](https://img.shields.io/github/last-commit/Li7777777/pi-leetcode-tools?branch=main&style=flat-square&logo=git&logoColor=white)](https://github.com/Li7777777/pi-leetcode-tools/commits/main)
[![LINUX DO - Where possible begins](.github/assets/linux-do-community-badge.svg)](https://linux.do)

[English](README.md)

`pi-leetcode-tools` 的独立源码与发布工作区。它为 LeetCode 国际站（Global）和中国站（CN）提供一组非官方的 Pi 原生工具调用。

包源码位于 `packages/pi-leetcode-tools`。本仓库包含工具包、测试和发布基础设施。

## 安装

```sh
pi install npm:pi-leetcode-tools@0.1.3
pi list
```

## 环境要求

- Node.js 22.19.0 或更高版本
- npm

## 开发

```sh
npm install
npm run typecheck
npm test
npm run build
```

常用的发布检查包括：

```sh
npm run verify:tools:release-workflow
npm run verify:tools:release:no-record
```

运行 `npm run pack:tools` 可创建并验证用于发布的包产物。

## 发布模型

发布流程采用失败关闭（fail-closed）策略。正式发布必须同时满足：

- 发布策略数据已经审核；
- 版本标签不可变；
- 已配置 npm Trusted Publisher；
- 注册表验证成功。

完整流程见 `release/TOOLS-BOOTSTRAP.md` 和 `release/tools-release-policy.json`。

14 个工具清单、Global/CN 差异、认证与安全边界，请参阅[包级中文文档](./packages/pi-leetcode-tools/README.zh-CN.md)。

## 许可证

MIT。详见 `LICENSE` 和 `NOTICE`。
