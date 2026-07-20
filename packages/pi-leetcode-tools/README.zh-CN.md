# pi-leetcode-tools

[![npm version](https://img.shields.io/npm/v/pi-leetcode-tools?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/pi-leetcode-tools)
[![npm downloads](https://img.shields.io/npm/dm/pi-leetcode-tools?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/pi-leetcode-tools)
[![CI](https://img.shields.io/github/actions/workflow/status/Li7777777/pi-leetcode-tools/ci.yml?branch=main&style=flat-square&logo=githubactions&logoColor=white&label=CI)](https://github.com/Li7777777/pi-leetcode-tools/actions/workflows/ci.yml)
![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.19.0-339933?style=flat-square&logo=nodedotjs&logoColor=white)
![Tests](https://img.shields.io/badge/tests-279%20passing-2ea44f?style=flat-square)
[![MCP parity](https://img.shields.io/badge/MCP%20parity-24%2F24-7c3aed?style=flat-square)](#参考-mcp-接口对齐)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/Li7777777/pi-leetcode-tools?style=flat-square&logo=github)](https://github.com/Li7777777/pi-leetcode-tools/stargazers)
[![Last commit](https://img.shields.io/github/last-commit/Li7777777/pi-leetcode-tools?branch=main&style=flat-square&logo=git&logoColor=white)](https://github.com/Li7777777/pi-leetcode-tools/commits/main)
[![LINUX DO - Where possible begins](https://raw.githubusercontent.com/Li7777777/cpa-key-hub/main/.github/assets/linux-do-community-badge.svg)](https://linux.do)

[English](./README.md)

面向 LeetCode 国际站（Global）和中国站（CN）的非官方 Pi 原生工具包。

## 14 个 Pi 工具

| 工具 | 用途 | 认证要求 |
| --- | --- | --- |
| `lc_daily` | 读取每日一题 | 无 |
| `lc_search` | 按分类、标签、难度或关键词搜索并分页浏览题目 | 无 |
| `lc_problem` | 读取题目、提示和代码片段 | 无 |
| `lc_solution_search` | 分页列出包含答案的社区题解 | 无 |
| `lc_solution` | 读取一篇完整的社区题解文章 | 无 |
| `lc_profile` | 读取指定公开用户的标准化资料 | 无 |
| `lc_contest` | 读取指定公开用户的竞赛排名与有界历史 | 无 |
| `lc_progress` | 读取当前账户的做题进度 | Session |
| `lc_history` | 读取账户级或单题提交历史 | Session |
| `lc_user_submissions` | 读取指定公开用户的最近或通过提交 | 无 |
| `lc_submission` | 读取单次提交；仅在显式设置 `includeCode=true` 时请求源码 | Session |
| `lc_run` | 远程运行代码，但不形成正式提交 | Session + CSRF |
| `lc_submit` | 经 Pi 自有界面逐次确认后提交代码 | Session + CSRF |
| `lc_operation_status` | 恢复或刷新已记录的运行/提交操作 | Session + CSRF |

题解工具虽然无需登录，但属于 `answer_read`，并带有 `disclosureRisk=solution`。它们只应在调用者明确要求时使用；包不会预取、批量抓取、缓存、记录或持久化题解内容。

## 快速开始

通过 Pi 安装本包，然后启动一个新的交互会话：

```bash
pi install npm:pi-leetcode-tools
pi list
pi
```

扩展会自动加载。可以直接用自然语言描述需求；希望明确选择工具时，也可以在提示词中写出工具名：

```text
使用 lc_daily 查询 LeetCode CN 今天的每日一题。
使用 lc_search 搜索 LeetCode Global 中等难度的数组题。
使用 lc_problem 读取 CN 的 two-sum，并显示 C++ 代码模板。
使用 lc_progress 汇总我的 CN 账户做题进度。
```

前三个示例属于公开读取。`lc_progress`、`lc_history`、`lc_submission`、`lc_run`、`lc_submit` 和 `lc_operation_status` 需要对应区域的账户凭据。使用本地认证 CLI 登录：

```bash
pi-leetcode auth login --region cn --profile personal-cn
```

Pi 会把包提供的可执行文件放在自己的 npm 管理目录中，该目录不一定在 shell 的 `PATH` 里。如果系统找不到 `pi-leetcode`，可通过该目录运行。

macOS/Linux：

```bash
npm exec --prefix "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/npm" -- \
  pi-leetcode auth login --region cn --profile personal-cn
```

Windows PowerShell：

```powershell
$agentDir = if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR } else { "$HOME\.pi\agent" }
npm exec --prefix "$agentDir\npm" -- pi-leetcode auth login --region cn --profile personal-cn
```

如果隔离浏览器无法通过站点验证，需要改用系统默认浏览器，请将 `auth login` 换成 `auth import`。登录或切换 profile 后应重新启动 Pi 会话。`lc_submit` 只能在交互会话中使用，并且每次提交都需要新的 Pi 界面确认。完整流程见[认证 CLI 与凭据配置](#认证-cli-与凭据配置)。

如果某项已安装资源被禁用，可运行 `pi config` 启用它，然后重新启动 Pi 会话。

## 验证状态

`pi-leetcode-tools@0.1.3` 已达到严格的上游接口对齐：固定参考面上的 24 个接口均已实现并验证，具体由 16 个原生工具映射、5 个 Gateway 能力和 3 个静态契约资源组成，不存在 `missing`、`partial`、`superseded` 或 `explicitly_unsupported` 映射。

| 检查项 | 当前证据 |
| --- | --- |
| 自动化测试 | 29 个测试文件 / 279 项测试通过 |
| 上游契约完整性 | 源码 344/344、打包产物 344/344 均通过 |
| 打包目标解析 | 24/24 通过 |
| 独立适配器、Gateway 与资源夹具 | 24/24 通过 |
| 公开读取冒烟测试 | Global/CN 的 daily、search、problem 共 6/6 通过 |
| 登录账户安全矩阵 | Global 19 项、CN 21 项操作零失败，覆盖区域支持的安全读取以及 `lc_run -> lc_operation_status` |
| 写入保护 | 安全矩阵默认强制跳过 `lc_submit` 与 Notes 新建/更新；只有单独、明确授权的交互验证才允许执行 |

LeetCode 是第三方服务，其接口可能在没有通知的情况下变化。使用本包并不免除用户遵守 LeetCode 条款和限流规则的责任。

## 参考 MCP 接口对齐

本包以固定的 `@jinzcdev/leetcode-mcp-server@1.4.0` 表面为参考：19 个 MCP 工具和 5 个 MCP 资源。不可变清单位于 `upstream/reference-surface.json`，语义映射位于 `upstream/parity.json`。

验证器不会只信任声明清单：它会离线核对参考 tgz 的大小、SHA-256、SHA-512 完整性，提取实际注册项，并要求工具名、资源 URI 模板和输入字段完全一致。参考实现所依赖的 `leetcode-query@2.0.1` 同样按 tgz 完整性、`lib/index.js` 摘要及 19 条内嵌 GraphQL 查询摘要固定；仅有兼容版本范围不能作为语义证据。

开发时可运行：

```bash
npm run verify:upstream-parity:report --workspace pi-leetcode-tools
npm run verify:tools:upstream-completeness:source
npm run verify:tools:upstream-completeness
```

普通的 `npm pack --dry-run --workspace pi-leetcode-tools` 保留非严格报告行为；生成发布产物或执行 `npm publish` 时会启用严格门禁，未完整实现的包不能发布。

## 环境要求与兼容性

- Node.js `>=22.19.0`。
- 当前验证过的 Pi 运行时为 `@earendil-works/pi-coding-agent@0.80.7`。
- 版本 `0.1.3` 携带契约版本 `1.1.0` 和 RPC 协议版本 `1.0.0`。
- 公开 JavaScript 子路径仅包括 `pi-leetcode-tools/embedded`、`pi-leetcode-tools/types` 和 `pi-leetcode-tools/contract`；包根路径和 `dist/` 深层导入会被阻止。

调用方必须先发现当前 provider，再比较包版本、契约版本、协议版本、schema digest 和 capability-manifest digest。任何不匹配都应视为不兼容，不能猜测兼容。并存多个 provider 实例会以 `PROVIDER_CONFLICT` 失败关闭，直到只保留一个实例。

## 安装、更新与移除

为 Pi 安装精确版本：

```bash
pi install npm:pi-leetcode-tools@0.1.3
pi list
```

项目级安装或移除可使用 `-l`。更新和移除会沿用安装时记录的来源：

```bash
pi update npm:pi-leetcode-tools
pi remove npm:pi-leetcode-tools
```

发布产物通过封闭的临时注册表验证，该注册表会把 `dist.integrity` 绑定到选定的 tgz，并在全新的 Pi 进程中执行激活探针。裸本地 tgz 适合普通 npm 生产依赖树审计，但 Pi 0.80.7 不会把它视为权威的 Pi Package 激活证据。

移除扩展并不保证删除持久化操作日志。清理前请先阅读“持久化操作与恢复”一节。

## 认证 CLI 与凭据配置

公开的每日一题、搜索、题目、公开资料、竞赛和题解读取不需要凭据。需要登录的工具优先从环境变量解析完整凭据组，其次从操作系统凭据库解析同一 profile/region 的凭据。工具参数永远不接收 Cookie 或 CSRF 值。

本地认证 CLI 的固定命令面如下：

```bash
pi-leetcode auth login --region global --profile personal-global
pi-leetcode auth status --profile personal-global
pi-leetcode auth list
pi-leetcode auth use --profile personal-global
pi-leetcode auth doctor --profile personal-global
```

中国站使用 `--region cn`。`auth login` 会启动隔离的本地 Edge 或 Chrome profile，等待用户在浏览器内完成 LeetCode 的正常登录流程。密码、CAPTCHA、MFA 和第三方登录均留在浏览器中；程序只把最终 Session 与 CSRF Cookie 保存到操作系统凭据库。无论成功、超时、关闭浏览器还是失败，临时浏览器 profile 都会被删除。

若隔离浏览器无法通过站点挑战，可使用显式回退：

```bash
pi-leetcode auth import --region cn --profile personal-cn
```

`auth import` 会打开系统默认浏览器，但不会扫描浏览器 Cookie 数据库、密码库、历史记录、扩展、调试端口、剪贴板或其他域。登录后，它只从本地可见终端中的两个隐藏提示读取 `LEETCODE_SESSION` 与 `csrftoken`。管道输入和非 TTY 环境会以 `auth_tty_required` 失败；秘密不会进入 argv，也不会被打印。

两条登录路径都会先对固定区域端点进行有界、只读的状态探测，再修改 keyring。已有凭据只有在提供 `--force` 时才会被覆盖；探测或 keyring 写入失败会保留旧凭据。登录或导入成功后会自动选中该 profile。

删除某个保存的登录：

```bash
pi-leetcode auth logout --region global --profile personal-global
```

`auth logout` 只删除指定 profile/region 的凭据组，并会安全地调整 active profile，绝不会留下指向已删除 profile 的活动指针。`auth status` 和 `auth list` 只输出非敏感状态，不显示 Cookie 内容、长度、摘要、keyring 账户名或远程用户名。`auth doctor` 执行新的只读探测：全部健康时退出码为 `0`，发现诊断问题时为 `2`。

常见 CLI 原因码包括：

| 原因码 | 含义与处理 |
| --- | --- |
| `credentials_already_exist` | 该 profile/region 已存在；换用新 profile，或明确使用 `--force` |
| `auth_environment_bundle_partial` | 环境变量只配置了一半或格式错误；补齐两项或全部清除 |
| `auth_tty_required` / `auth_import_cancelled` | 导入需要可见的隐藏输入终端，或用户取消了本地提示 |
| `auth_browser_unavailable` / `auth_browser_closed` / `auth_login_timeout` | 隔离浏览器无法启动、被关闭或登录超时 |
| `auth_probe_rejected` / `auth_expired` | LeetCode 不接受该会话；重新登录 |
| `auth_region_mismatch` | 导入的会话跳转到了所选 Global/CN 来源之外；检查区域和 Cookie |
| `credential_store_unavailable` | 系统 keyring/Secret Service 缺失、锁定或被拒绝；不会回退到明文文件 |
| `credential_store_corrupt` / `credential_store_rollback_failed` | 非敏感索引损坏，或 keyring 事务恢复失败；停止替换并运行 `auth doctor` |

## 环境变量

环境变量适用于 CI 和无头部署。解析优先级是：完整环境变量凭据组 → 同一 profile/region 的操作系统凭据库 → 未配置。半套环境变量会遮蔽 keyring，并以 `auth_environment_bundle_partial` 失败关闭；环境值与已存值绝不会拼接使用。

| 区域 | Session Cookie 值 | CSRF Cookie 值 |
| --- | --- | --- |
| 国际站（`global`） | `LEETCODE_SESSION` | `LEETCODE_CSRF_TOKEN` |
| 中国站（`cn`） | `LEETCODE_CN_SESSION` | `LEETCODE_CN_CSRF_TOKEN` |

请在启动 Pi 前设置。以下占位符不是实际值：

```bash
export LEETCODE_SESSION='<session-cookie-value>'
export LEETCODE_CSRF_TOKEN='<csrf-cookie-value>'
export PI_LEETCODE_PROFILE_ID='personal-global'
```

PowerShell：

```powershell
$env:LEETCODE_CN_SESSION = '<session-cookie-value>'
$env:LEETCODE_CN_CSRF_TOKEN = '<csrf-cookie-value>'
$env:PI_LEETCODE_PROFILE_ID = 'personal-cn'
```

`PI_LEETCODE_PROFILE_ID` 是非敏感的本地命名空间，默认为 `default`。不同 LeetCode 账户应使用不同且稳定的 profile ID；它会隔离操作日志和锁、绑定认证游标，并出现在非敏感能力元数据中。复用同一 ID 可能让操作恢复产生歧义，修改 ID 则可能使旧操作和游标在新 profile 下不可用。

执行 `auth use`、替换登录、导入或登出后，如果有效 profile 发生变化，请启动新的 Pi 会话或显式重新发现 provider。运行时会立即提升 `contextRevision`，旧游标、确认和未派发写意图都会失败关闭，避免跨账户写入。

原生 keyring 后端映射到 Windows Credential Manager、macOS Keychain 和 Linux Secret Service。服务缺失或锁定时，命令会稳定返回 `credential_store_unavailable`；不会回退到明文 JSON、`.env`、项目目录或用户主目录中的秘密文件。

请把 Session 与 CSRF 值当作密码：不要把它们粘贴到提示词、工具参数、源码、日志、Issue 或已提交的 `.env`。如有泄漏，应立即轮换。

## Global 与 CN 行为差异

| 能力 | Global | CN |
| --- | --- | --- |
| `lc_daily`、`lc_search`、`lc_problem` | 支持 | 支持 |
| `lc_profile`、`lc_contest` | 接收明确的公开用户名，不隐式使用当前账户 | 同样支持，并保留区域特有资料字段 |
| `lc_progress` | 需要 Global 会话 | 需要 CN 会话 |
| `lc_history` | 支持账户级或单题历史；拒绝 CN 专属筛选项 | 额外支持规范化 `language` 及 `accepted` / `wrong_answer` 状态筛选 |
| `lc_user_submissions` | 支持 `recent` 和 `accepted` | 仅支持公开的 accepted 历史 |
| `lc_submission` | 需要 Global 会话；源码默认不读取 | 需要 CN 会话；源码默认不读取 |
| `lc_run`、`lc_submit`、`lc_operation_status` | Session + CSRF | Session + CSRF |
| 社区题解读取 | 支持，内容属于不受信任的第三方输入 | 支持，内容属于不受信任的第三方输入 |
| `user.status` Gateway | 支持 | 支持，并单独返回 CN display name |
| Personal Notes Gateway | 不支持 | 支持 search/get/create/update；写入需逐次确认 |

`lc_search` 默认分类为 `all-code-essentials`、默认每页 10 项，并只接受固定目录中的分类和标签。`lc_daily` 返回 UTC 调用日期以及严格的区域载荷。`lc_problem` 默认返回简化投影；设置 `includeResourcePayload=true` 时会额外返回经过有界 schema 验证的完整固定资源载荷，未知字段不会直接转发给模型。

## 运行、提交与交互确认

`lc_run` 和 `lc_submit` 对齐 Global/CN 的 `interpret_solution -> check` 与 `submit -> check` 流程。二者支持固定上游表面的 20 个语言 slug；`golang` 在包内标准化为 `go`，发送时再映射回 `golang`。未提供操作控制项时，默认 `timeoutMs=120000`、`pollIntervalMs=1500`；总超时上限为 120 秒，请求轮询间隔上限为 5 秒。

`lc_run` 未提供 `testcase` 时，会解析并发送题目公开 `sampleTestCase` 的精确字节。如果题目没有公开默认用例，调用会在派发前失败，而不是猜测或发送含义不明的空用例。

`lc_submit` 每次都必须通过当前活动 Tools 扩展拥有的 Pi 交互界面确认。RPC 调用者不能传入或伪造确认回调；在 `--print`、纯 RPC 或其他无 UI 会话中，提交以 `INTERACTION_REQUIRED` 失败关闭。

读取工具、`lc_run` 和 `lc_operation_status` 在凭据满足时可以无头运行。请注意，`lc_run` 仍会把代码发送给 LeetCode 远程执行，只应运行用户明确希望执行的代码。

CN Personal Notes 的 `notes.create` 与 `notes.update` 同样要求 Tools 自有 UI 的逐次确认，且绝不自动重试。Global Notes 不支持。CN note 限制为 16 KiB，采用尽力而为的 compare-and-set，而不是服务器原生原子 revision。

## 持久化操作与 `unknown` 恢复

运行和提交都会在远程派发前写入日志。`unknown` 表示无法证明远程结果，**不表示请求失败**；盲目再次提交可能产生重复记录。

遇到 `unknown` 时：

1. 保留 `operationId`，调用 `lc_operation_status`。
2. 若 LeetCode 现在可返回结果，状态会推进到 `polling`、`completed` 或 `failed`。
3. 若提交仍为 `unknown`，仅在用户接受重复提交风险后重试：使用完全相同的 region、problem、language 和 code 调用 `lc_submit`，并把旧 ID 传给 `retryUnknownOperationId`。
4. 通过新的交互确认；新记录会用 `supersedesOperationId` 关联旧记录。

引用不匹配会以 `STALE_OPERATION` 拒绝。相同的待处理或未解决提交会被阻止。普通 `lc_submit` 若命中保留中的已完成操作，会返回旧结果；确实要再次提交相同代码时，必须提供 `resubmitCompletedOperationId`，再次确认，并通过 `repeatsOperationId` 关联新旧记录。

远程派发后的本地取消仍可能得到 `unknown`；本地取消不是 LeetCode 已取消请求的证据。

持久化状态位于：

```text
<Pi 解析出的 agent 目录>/leetcode-tools/
  operations/<sha256(profile-id + region)>/operations.json
  locks/
```

运行与提交状态使用 Pi 解析出的 agent 目录：默认是 `~/.pi/agent`，也可以通过可选的 `PI_CODING_AGENT_DIR` 覆盖。自定义目录的部署必须在重启后继续使用同一路径；使用 Pi SDK 嵌入并自定义 agent 目录时，应向 `createLeetCodeToolsRuntime` 传入匹配的 `storageDirectory`。

日志保存 ID、状态转换、远程 ID、时间戳、题目/语言元数据、结果和代码 SHA-256；持久化策略拒绝源码、测试用例、凭据、Cookie、CSRF Token 和确认 Token。日志本身未加密，应使用正常的操作系统账户权限保护 Pi agent 目录。

待处理或 `unknown` 操作存在时不要删除日志，否则会失去恢复和防重复提交所需的证据。手动清理前，应先解决或明确放弃这些操作，并停止所有使用同一 profile 目录的 Pi 进程。

## Gateway 与嵌入式导出

除 14 个模型工具外，包还提供 5 个非模型 Gateway RPC 能力：

- `user.status`：只读认证身份状态，支持 Global/CN；
- `notes.search`、`notes.get`：CN Personal Notes 的有界读取；
- `notes.create`、`notes.update`：CN Personal Notes 写入，每次都要求新鲜的 Pi UI 确认。

这些能力不会注册为 `lc_*` 模型工具。Gateway 通过固定 discovery/RPC 协议公开 provider descriptor；消费者必须验证版本和摘要，且不能把 RPC 输入当作可信的用户确认。Notes 内容、标题和关键词不会进入日志或发布证据；确认界面只显示字节数和 SHA-256 摘要。无法安全验证 Notes 写入时会返回 `UNKNOWN_WRITE_OUTCOME`，调用者应先读取再决定是否重试，绝不能自动重放。

需要把 Tools 嵌入另一个 Pi 包时，可使用公开子路径：

```ts
import { createLeetCodeToolsRuntime } from "pi-leetcode-tools/embedded";

const runtime = createLeetCodeToolsRuntime(pi);
const registration = runtime.registerTools();

if (registration.status !== "failed" && registration.status !== "collision") {
  await runtime.activate(ctx);
}

// session_shutdown
await runtime.deactivate();
```

`registerTools()` 与 `activate()` 有意分离：嵌入方应在 Pi 扩展工厂加载完成后的 `session_start` 阶段协商 `lc_*` 命名空间所有权，只激活自己拥有的 provider。检测到名称冲突、部分注册失败或陈旧激活时会失败关闭，不会覆盖其他扩展。`deactivate()` 会先停止 discovery/RPC 流量，再关闭底层 client。

`pi-leetcode-tools/types` 提供公共类型，`pi-leetcode-tools/contract` 提供固定 schema、版本与协议常量。不要从包根或 `dist/` 内部路径导入。

## 分页与游标

`lc_search` 和 `lc_history` 返回不透明的 HMAC-SHA256 游标。游标最多 1,000 个字符，15 分钟后过期，并绑定工具、区域、查询指纹和分页位置；历史游标还绑定凭据 profile。

签名密钥只存在于当前运行时，因此游标不能跨 Pi 重启、provider 实例、profile 变更或包升级使用。不要解析、修改、长期保存或分享游标。遇到 `STALE_CURSOR` 时，应丢弃旧游标并从头开始分页。

`lc_contest` 使用精确的 50 条 offset 页；完整上游历史仍可逐页访问，但单次模型响应保持有界。题解搜索和公开提交历史同样只返回有界窗口，不代表完整账户历史。

## 结果与错误处理

每个工具都返回结构化的成功或失败 envelope。失败时应根据 `error.code` 处理，尊重 `retryable`，在存在 `retryAfterMs` 时等待，并保留返回的 `operationId`。不要仅根据人类可读消息决定重试。

| 错误码 | 含义与调用方操作 |
| --- | --- |
| `VALIDATION_ERROR` | 输入不符合公开 schema；修正请求 |
| `AUTH_REQUIRED` | 缺少所需区域凭据 |
| `AUTH_EXPIRED` | 当前会话已不被接受；轮换凭据 |
| `PERMISSION_DENIED` | 账户或上游策略拒绝操作 |
| `INTERACTION_REQUIRED` | 需要可信的 Pi UI 确认 |
| `NOT_FOUND` | 题目或本地操作记录不存在 |
| `RATE_LIMITED` | 退避，并在提供时遵守 `retryAfterMs` |
| `REMOTE_UNAVAILABLE` | LeetCode 或网络暂时不可用 |
| `EXECUTION_FAILED` | 工具/运行时无法安全完成操作；检查 `retryable` 和操作状态。WA/TLE 等判题结论仍是成功返回的业务结果 |
| `UNSUPPORTED_REGION` | 请求区域不受支持 |
| `STALE_OPERATION` | 操作重复、已终结、不匹配，或缺少显式 unknown 重试引用 |
| `STALE_CURSOR` | 游标过期、无效或属于其他上下文 |
| `UNKNOWN_WRITE_OUTCOME` | Notes 写入可能成功但无法验证；先读取，禁止自动重放 |
| `CANCELLED` | 本地工作已取消；已派发的远程工作仍可能为 `unknown` |
| `CAPABILITY_UNAVAILABLE` | 运行时、存储、凭据或区域能力不可用 |
| `REMOTE_SCHEMA_CHANGED` | LeetCode 响应不再符合适配器；升级或报告问题 |
| `PROVIDER_CONFLICT` | 活动 Tools provider 超过一个；移除重复实例 |
| `CONTRACT_MISMATCH` | 包与消费者的契约证据不一致；不要跨该边界调用 |
| `PROTOCOL_TIMEOUT` | 内部 RPC 超时；重试前重新发现上下文 |

## 安全边界

- 凭据永不作为工具参数，也不会写入操作日志、诊断或发布证据。
- `lc_submission` 默认不向 LeetCode 请求源码；只有调用者显式设置 `includeCode=true` 才会读取。返回的源码和判题输出属于敏感、不受信任内容，不会写入操作日志、Notes、诊断或发布证据。
- `lc_run`/`lc_submit` 的完整起始与终态上游 JSON 仅在当前调用中短暂存在。包含源码、凭据、原型污染或其他禁止字段的载荷会被拒绝，并且不会进入持久化日志。
- 社区题解、题目正文、用户资料和远程输出都应视为不受信任的第三方内容。
- 安全日志路径会遮蔽已知凭据和代码字段，但无法保护用户在该路径之外主动披露的秘密。
- 发布产物从最终 `.tgz` 检查文件 allowlist、安全声明、内建 secret scan、隔离的生产依赖树、许可证策略、CycloneDX SBOM 和发布证据记录。

威胁模型和私密报告方式见 [SECURITY.md](./SECURITY.md)。

## 本地开发

在工作区根目录运行：

```bash
npm ci
npm run typecheck
npm test
npm run build
pi -e ./packages/pi-leetcode-tools
```

调试上游对齐时，可先运行报告模式；准备发布时必须通过严格的源码与打包完整性门禁。

## 许可证

MIT。详见 `LICENSE` 和 `NOTICE`。
