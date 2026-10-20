# dsh-github-gate

**面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 GitHub 工具：写操作不会意外发生。**

9<!--stats:tool_count--> 个类型化 `github_*` 工具，全部基于 GitHub CLI，共 61<!--stats:action_count--> 个动作。**其中 29<!--stats:destructive_count--> 个改动远端状态的动作必须先有
`confirm: true`，再经过一道人工审批门。** 模型设的那个标志是它的意图，不是用户的同意。

```text
github_pr { action: "merge", number: 42, confirm: true }
  → 弹出审批提示，写明是哪个 PR；回答「否」就停下
  → 同意后才执行 gh pr merge 42 --repo owner/name
```

- **argv 数组，永不经过 shell。** `gh` 以 `shell: false` 启动，模型给的文本在结构上就无法变成
  shell 语法——不是靠过滤。
- **一条凭据链，每次调用重新解析。** DSH 凭据存储 → `GH_TOKEN` / `GITHUB_TOKEN` →
  `gh auth login` → git credential helper。轮换 token 对下一次调用即生效。
- **在 GUI 里配置。** 设置 → 插件 → GitHub：粘贴 PAT、对着 API 测一次连通、看到当前生效的是
  哪一层。token 不会被回显。
- **分支胶囊**在会话头部：当前分支、它的 PR，以及一个在无法判定调用者时**拒绝服务**的切换菜单。
- **摘要校验的自更新。** `github_update` 暂存一个 release，其 sha256 会与 GitHub 公布的值核对。

Host 侧工具，加一个小浏览器半身。0<!--stats:runtime_dependencies--> 运行时依赖。无构建步骤。

> **要求**：DeepSeek Harness `>=0.2.0-0 <0.3.0`，以及 `PATH` 上的
> [GitHub CLI](https://cli.github.com/)（`gh`）。Linux / macOS / Windows 均可。

**Topics：** `dsh-plugin` · `deepseek-harness` · `dsh` · `cordis-plugin` · `github` · `gh-cli`

## 目录

- [安装](#安装)
- [这个包提供什么](#这个包提供什么)
- [配置](#配置)
- [凭据链](#凭据链)
- [Device Flow 需要你自己的 OAuth App](#device-flow-需要你自己的-oauth-app)
- [安全模型](#安全模型)
- [后台任务](#后台任务)
- [已知限制](#已知限制)
- [开发](#开发)

## 指导层

除了工具，本插件还提供一个**系统提示词 section** 和三个**技能**，用来表达 schema 说不出来的东西：
什么时候该用哪个能力、一个结论需要什么证据、什么时候该停。规则刻意很少——提示词每一步都要付费——
而且每条都点名它适用的工具。

三个按需加载的工作流：`github-pr-review`、`github-ci-triage`、`github-issue-to-pr`。

缺少 `systemPrompt` 或 `skills` 服务的组合不会因此失效：工具照常工作，指导层只是不注册。
诊断路由会报告哪一半是活的。

## 安装

两种方式，都通过 Harness 的插件管理器（`plugin_manager` 的 `install_bundle`）：

1. **从 GitHub Release 安装** —— 从 [Releases](../../releases) 下载
   `dsh-github-gate-<版本>.tgz`，让 `install_bundle` 指向解包后的包目录，或指向存放它的本地路径。
2. **从自己的 checkout 打包安装**：

   ```bash
   npm pack --pack-destination ../packages     # 在源码目录之外打包
   ```

   然后安装 `../packages/dsh-github-gate-<版本>.tgz`。

**用打包好的 tarball 安装，不要从源码目录安装。** 这不是风格偏好。把工作区目录以 `link:`
方式安装会生成一个 junction，而 launcher 的 runtime resolution 不会经由它提供裸
`@deepseek-ai/*` 包——插件随后会以 `ERR_MODULE_NOT_FOUND` 失败并**完全无法激活**。

**tarball 必须打在源码目录之外**：曾经有一次把 tarball 打在源码目录内部，安装完成后该目录被清空
（见 [docs/DESIGN.md](./docs/DESIGN.md) §5.8）。

tarball 是快照，改动源码需要重新打包并安装；新的模块世代需要重启才会加载。

### 为什么声明了 `peerDependencies`

插件导入 `@deepseek-ai/schemastery`（Config schema）与 `@deepseek-ai/dsh-tools`（`defineTool`）。
runtime resolution 依据插件**自己的 manifest** 决定提供什么——`profileDependencyNames` 读取
`dependencies` 与 `peerDependencies`——所以**没有声明**的裸导入无法解析，插件会在导入期就
死掉。所声明的范围接纳当前 dsh 版本，这正是它不会触发 `evaluatePluginCompatibility`
版本豁免要求的原因。

## 这个包提供什么

| 工具 | 覆盖范围 |
|---|---|
| `github_auth` | 凭据链状态、**端到端连通性探针**、Device Flow 登录、PAT 登录、登出 |
| `github_repo` | view、list、branches、clone、create、edit、rename、archive、delete |
| `github_pr` | list、view、diff、checks、status、create、comment、review、ready、checkout、merge、close、reopen、edit |
| `github_issue` | list、view、create、comment、close、reopen、edit、develop |
| `github_release` | list、view、create、edit、upload、download、delete |
| `github_actions` | run list/view/log/watch/rerun/cancel/delete，workflow list/view/dispatch |
| `github_search` | 仓库、issue、pull request、代码、提交 |
| `github_api` | 其余一切的带护栏 REST 直通（`allowRawApi: true` 时注册） |

## 配置

```yaml
- id: github-gate
  name: dsh-github-gate
  config:
    defaultRepo: owner/name          # 调用省略 repo 时的兜底；留空则从工作区 remote 推断
    timeoutMs: 60000                 # 通用命令超时
    watchTimeoutMs: 300000           # watch/log 类动作以及可后台化的动作
    allowDestructive: true           # merge/delete/force-push 的总闸
    approvalForDestructive: true     # 破坏性动作执行前询问用户
    allowRawApi: true                # 注册 github_api
    blockShellGit: false             # 通过 tools guard 拒绝 shell 层的 git 提交/推送/合并
    credentialRef: GITHUB_TOKEN      # 凭据存储中的引用名
    deviceFlowClientId: ''           # 你自己的 OAuth App client id
```

完整字段与校验规则见 `lib/config-schema.js`；非法取值会在**插件加载时**失败并给出明确信息，
而不是在首次调用时静默降级。

## 凭据链

按「最省事且最显式者优先」的顺序尝试，并且**每次调用都重新读取**，因此会话中途存入的凭据
无需重启即刻生效：

1. dsh 凭据存储（`credentialRef`，默认 `GITHUB_TOKEN`）
2. 宿主环境里的 `GH_TOKEN` / `GITHUB_TOKEN`
3. GitHub CLI 自己的登录（`gh auth token`）
4. git 的凭据助手（`git credential fill`，已禁用交互提示）

因此**已经能 `git push` 的机器无需任何配置即可使用**。在完全没有凭据时，用 `github_auth`
的 `login` 动作建立一个。

## Device Flow 需要你自己的 OAuth App

`github_auth` 的 `login` 动作走 GitHub Device Flow，只与 `github.com` 通信——没有中间商，
机器上不存密钥。它需要一个 client id，而**这个值没有预填**：client id 标识你的授权被授予
了哪个应用注册，预填一个就会把你的访问权导向一个你无法审计、也无法撤销的他人应用。

在 <https://github.com/settings/applications/new> 注册一个启用 Device Flow 的 App，然后：

```yaml
    deviceFlowClientId: 'Ov23li...'
```

已经用 `gh auth login` 登录过的机器不需要这一步：凭据链会自动发现它。

## 安全模型

- **argv 数组，`shell: false`。** 没有任何构造出来的参数会被 shell 解释。一个恶意的
  `title` 会作为**单个参数**原样保留。
- **三层破坏性动作防护**，从强到弱：
  1. `allowDestructive: false` —— 硬停，在 `execute` 内部检查；
  2. **审批询问** —— 通过官方的 `tools/pre-execute` seam 询问用户，理由里写明目标；
  3. `confirm: true` —— 模型对该次调用的意图声明。
  第 2 层是本次新增的：此前唯一的闸门是第 3 层，而那是模型自己声明的，**不是同意**。
  没有审批服务的组合会在第 2 层拒绝，因此这条路径永远不会变成静默放行。
- **只读动作可并行**（`isConcurrencySafe`），写动作串行。`github_api` 是例外：它读还是写
  取决于 `method` 参数，因此**永远不被判定为安全**。
- **`github_api` 的 `path` 必须是相对路径**：绝对 URL 与协议相对路径会被拒绝，所以它无法
  被指向 GitHub 以外的站点。
- **请求体经 stdin**，且绝不出现于 argv。
- **REST 走 `gh api` 而非直接 fetch。** 直接 fetch 会引入第二条配置不同的网络路径（Node 的
  CA 库而非平台的），在存在 TLS 拦截但操作系统信任该证书的机器上会失败。

## 选择分支

任何表示 git ref 的参数都接受两个哨兵值，在构造 argv 之前解析：

| 哨兵 | 含义 |
|---|---|
| `@current` | 工作区**当前检出的分支**（`git rev-parse --abbrev-ref HEAD`） |
| `@default` | **仓库自己的默认分支** |

```
github_actions { action: "list", branch: "@current" }   # 我这条分支上的 CI
github_pr      { action: "list", base: "@default" }     # 打到主干上的 PR
```

`github_actions list` 的 `branch` **默认就是当前分支**（这个动作存在的意义是回答「CI 为什么
红了」，问的就是你手头的活）。传 `branch: "*"` 可列出全部分支。

`github_pr list` **刻意不设默认**：`gh pr list` 本来就是列出所有开着的 PR，隐式加一个 base
过滤会把 list 的意义抹掉。

**插件替你选的分支一定会写进结果**，不会静默：

```
[ref] branch: fix/ci (current branch)
```

理由：一个悄悄收窄结果的过滤器，会让人得出「这里什么都没有」的结论，而实际有。

哨兵无法解析时（例如 detached HEAD——`git rev-parse` 会输出字面量 `HEAD`）**原样保留**，
让 gh 明确报错，而不是把参数丢掉、悄悄跑成「不带过滤」。

### 插件不能做什么

**它不能切换你本地工作区的分支。** 插件里没有任何本地 git 命令（刻意丢弃，见
DESIGN.md §8.6——与 dsh 自身 shell 工具重叠且会绕过宿主权限）。切换分支仍然是：

```
git checkout <branch>
```

只有 `github_repo clone`（克隆并检出）与 `github_pr checkout`（检出某个 PR 的分支）会动本地
工作树，两者都是 GitHub 语义。

## 后台任务

长动作（`github_actions` 的 `runLog`/`runWatch`，`github_release` 的 `upload`/`download`）接受
`run_in_background: true`：

```
github_actions { action: "runWatch", repo: "a/b", runId: "123", run_in_background: true }
  -> data: { kind: "background", jobId: "github-1" }
```

遵循官方约定：立即返回 id，**后台执行不设超时**，用 `job_output` 收集、用 `job_kill` 终止。
句柄是**程序化字段**（`data.jobId`），PTC mode 不必解析渲染文本。

没有组合 job registry 时，调用会明确报告 `background jobs unavailable`，并告诉你该加载什么
——它不会静默地退化为前台执行。

## 已知限制

- **Device Flow 未经真实授权往返验证**：轮询状态机用注入的 fetch 完整覆盖，但真实的
  github.com 往返需要你自己的 OAuth App 与浏览器交互。
- **未执行任何写操作**：全部验证都是只读的；没有创建、合并或删除过任何真实资源。
- **无客户端半身**：不提供设置页或状态栏卡片。卡片走通用的 `presentCall`/`presentResult`
  路径，并带有正确的 `kind`（read / search）。
- **源码改动不会自动生效**：tarball 是快照。
- **PTC mode 未实测**：`defineTool` 使 `await tools.<name>(args)` 可用，但本插件未在 PTC
  preset 下跑过。

未采纳但有价值的设计（结构化审查的证据路由、幂等 PR 创建、diff 预算、flow-state）记录在
[docs/DESIGN.md](./docs/DESIGN.md) 第八节。

## 开发

```bash
npm run vendor    # 从 dsh 安装重建 @deepseek-ai 包（离线测试需要）
npm test          # 离线套件：不需要网络、不需要 gh
npm run probe     # 用真实的 defineTool 验证 DSL 约束
npm run verify    # 交付前的 bundle 完整性检查
npm run test:live # 可选的只读验证，走真实 gh
```

离线套件**刻意不 stub** `@deepseek-ai/*`：`tools/asar-vendor.mjs` 从 `app.asar` 逐字节重建
真实包，`test/resolve-hook.mjs` 只重定向这些裸说明符。stub 只会测到 stub。

MIT 许可，见 [LICENSE](./LICENSE)。变更见 [CHANGELOG.md](./CHANGELOG.md)。
