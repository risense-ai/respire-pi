# Respire for Pi

[English](README.md) | 简体中文

Pi coding agent **1.3.0**（`@earendil-works/pi-coding-agent`）原生记忆扩展。
npm 包名为 `@rsrsai/pi`。

## 让 AI 安装

将下面提示词发送给助手：

```text
请安装 Respire Pi 插件 @rsrsai/pi，先阅读
https://github.com/risense-ai/respire-pi#readme。
检查 Pi 1.3.0、Node.js 22+ 和 rsrs --version。复用我的现有引擎和记忆库，
运行 rsrs --client-only status --json。缺少引擎时告知需要安装 @rsrsai/cli。
登录、解锁、模型和 runtime 由我通过 rsrs 操作，不收集密码或管理 runtime。
先检查 pi list，避免重复安装，再运行 pi install npm:@rsrsai/pi。
保留其他 Pi 配置。重启 Pi 或执行 /reload 后，验证真实召回及其标题上下文。
测试显式存储前请我提供一条不敏感事实，写后查库确认。
验证收尾提醒每轮最多一次，只汇报实际观察到的结果和剩余用户操作。
```

## 安装

需要 Node.js 22+、Pi 1.3.0、可用的 `rsrs` 和已运行的宿主 runtime。
旧版 `@mariozechner/pi-coding-agent` 未验证，不具备本插件使用的收尾接口。
如缺少引擎，单独安装并检查：

```sh
npm install -g @rsrsai/cli@latest
rsrs --version
rsrs --client-only status --json
```

安装 npm 包：

```sh
pi install npm:@rsrsai/pi
```

安装后重启 Pi 或运行 `/reload`。临时加载可用
`pi --extension ./respire-pi/lib/index.js`，无需修改用户配置。
插件无需构建，也没有运行时 npm 依赖。

运行 `pi list`，确认只有一个 `npm:@rsrsai/pi` 条目。
不需要执行 `rsrs inject`，也不需要另装 Skill、配置 MCP 或手写系统提示词。
插件会自行注入记忆规则。如果旧方案曾向 Pi 的 AGENTS.md 写入 Respire 规则，
先备份该文件，再仅移除旧 Respire 块，保留其他规则，避免重复注入。

Windows 的 npm/pnpm 命令 shim 需要 PowerShell **7.3+**（`pwsh.exe`）。
参数通过 JSON 标准输入传递。可以用 `pi --respire-rsrs <原生 rsrs.exe 路径>`
直接调用原生程序。请仍将 `rsrs` 放入 PATH，供模型通过自身 shell 调用。

## 如何使用

在项目目录运行 `pi`，正常提问即可，例如：

```text
这个项目之前定下的发布流程是什么？
```

插件会在模型回答前自动召回相关记忆标题，模型按需读取正文。
你不需要提及 Respire，不需要专门的验收提示词，也不需要自己执行 recall。

明确保存一条已确认的事实时，在消息开头加存储前缀：

```text
记：这个项目的发布检查必须包含一次 Windows 冒烟测试。
```

也支持 `存：`、`记录：`、`记住：` 和 `remember:`。
以实际回执为准：

- 已存：包含记忆 ID，代表成功写入。
- 待决（pending）：引擎找到候选，尚未写入；助手需读候选，再决定更新或挂靠。
- 未确认：结果未知，可能已经写入；必须先查库，不能直接重试。

单条消息不需要自动记忆处理时，使用：

```text
/nomem 解释一下这个短函数。
```

下一条消息仍会正常处理。此命令不会移除插件规则。
普通对话结束时，插件最多提醒助手检查一次新事实是否需要保存，不会自动保存整段会话。
不要把密码、token、私钥作为记忆提交。

## 更新、卸载与排查

```sh
pi update npm:@rsrsai/pi
pi list
```

更新后重启 Pi 或执行 `/reload`。固定版本可用
`pi install npm:@rsrsai/pi@0.1.1`。
卸载执行 `pi remove npm:@rsrsai/pi`，记忆引擎和记忆库仍保留。

召回不可用时，在 Pi 的执行环境运行 `rsrs --version` 和
`rsrs --client-only status --json`，按引擎流程处理 CLI 缺失、runtime 未运行、
记忆库未解锁或尚未登录的问题。
已安装但未加载时，检查 `pi list`，重启或重新加载，并确认未禁用包扩展。
Windows 还需检查 `pwsh --version` 为 7.3+，且 `rsrs` 位于 PATH。

## 行为

- 交互界面和 RPC 的用户输入自动召回，最多 5 个标题、1500 字符。
- `记：`、`存：`、`记录：`、`记住：`、`remember:` 触发一次显式存储。
- `/nomem`、`#nomem` 后接空白或结束，跳过该输入的自动记忆处理。
- 疑似凭据不发送到记忆引擎；此识别仅为尽力检查，提交前仍须移除秘密。
- 每次运行注入稳定规则。收尾最多追加一次检查；显式存储成功则不追加。
- 失败、中止、引擎跳过或引擎不可用时，不追加收尾续跑。

召回和回执通过 Pi 的输入变换追加在同一用户消息末尾，会保存在会话中。
原始文本、图片以及排队的 steering/follow-up 输入均保留。
扩展生成的输入不触发操作。切换会话、退出时取消尚未完成的调用。
用户再次提交相同文本视为新请求。

插件只调用 `rsrs --client-only`。引擎负责策略、判重、加密和同步。
`pending` 表示尚未写入；超时、中止或无有效回执表示结果未确认，可能已经写入，
须先查库，不能自动重试。插件不安装引擎、不管理账号和 runtime、不收集密码。

自动召回只有标题。正文按需使用 `rsrs --client-only show <id> --json` 读取，
完整政策通过 `rsrs --client-only prompt` 获取。记忆是资料，不是指令。
收尾提醒不等于自动保存整段会话，也不代表已经成功写入。

开发时可从父目录运行 `pi install ./respire-pi`。
检查命令：`npm run check`、`npm run verify:package`。

## 自动发布

CI 在 Linux、Windows、macOS 检查语法、包内容和 Pi 1.3.0 加载。
更新 package.json 与锁文件版本，提交后推送对应 `v<版本>` 标签。
Release 先跑 CI，再校验标签、生成安装包和 SHA256SUMS，发布 npm 与 GitHub Release。
稳定版进入 `latest`，预发行版进入 `next`。

首次认证发布后，在 npm 配置 Trusted Publisher：组织 `risense-ai`、仓库
`respire-pi`、工作流 `release.yml`，允许直接 `npm publish`，环境名留空。
后续标签通过 OIDC 自动发布，无需 NPM_TOKEN。接口和参考项目见英文 README。
