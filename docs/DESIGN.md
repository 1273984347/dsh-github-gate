# dsh-github-toolkit 蒸馏设计说明

三个来源仓库的取舍记录。目标不是合并三个仓库，而是**只取各自真正站得住的部分**，
拼成一个与 dsh 0.2.0-rc.2 兼容、不触发 peer 版本豁免闸门的单一 host 插件。

- 来源 A：`Planckbaka/dsh-plugin-github-workflows` @ `84026c6`（v0.2.2，MIT）
- 来源 B：`KryptonGao/dsh-github-integration` @ `bfe7365`（v0.1.0，MIT）
- 来源 C：`kaziii/dsh-github-connector` @ `34117bf`（多包 monorepo，MIT）

## 一、结论先行：每个来源保留什么

| 来源 | 保留 | 丢弃 |
|---|---|---|
| A | 进程运行器（argv 数组、无 shell、双路 kill、内存截断+spill 文件、凭据回退链）；domain-table 工具注册；4 道安全门；JSON Schema 子集封装 | 12 个工具里低价值的 Codespaces 与 raw CLI 透传；`git` 域（与 dsh 自己的 pwsh/bash 工具重叠且会绕过宿主权限） |
| B | 工作区 remote 解析；`safeBranchName` 净化；git safety guard 的**阻断思路** | 第三方 OAuth broker（`dshgithubintegration.chenkai.space`）与 GitHub App 私钥托管；React 客户端半身（214 KB）；`dsh.client.inject` 里对不存在的 `dsh-client-runtime` 的依赖 |
| C | Device Flow 授权（直连 github.com，无中间人）；REST 传输层（Link 分页、错误分类、限流处理、日志重定向不带 token）；diff 预算；flow-state 四态机；幂等 PR 创建 | 五包 seam 抽象层（对单插件场景过度设计）；UI 包；全部 `^0.1.x` peer 声明（不含 0.2.0-rc.2，会触发豁免闸门） |

## 二、为什么这样取舍

### 2.1 基座选 A 而不是 C

C 的 seam 架构（`ctx.github` 能力缝 + provider 注册 + 执行时解析）在**多 provider**
场景下是有价值的抽象。但我们要交付的是**一个插件**，只有一个 provider（gh CLI）。
引入 seam 意味着多出 5 个包、每个都要满足 peer 范围、还要维护一层 provider 接口——
换来的只是「将来可能换 provider」这个假设。不划算。

A 的 domain-table 设计则**直接可复用**：一个 `actions` 映射，每个 action 声明
`needs` / `check` / `argv` / `destructive`，注册器统一施加四道门。加一个动作只改数据。

### 2.2 凭据模型：直连，不引入第三方

B 的默认配置把 GitHub App 的 client secret 与私钥指向第三方 broker：

```
redirectUri: https://dshgithubintegration.chenkai.space/github/oauth/callback
brokerUrl:   https://dshgithubintegration.chenkai.space
clientSecretRef: GITHUB_APP_CLIENT_SECRET
privateKeyRef:   GITHUB_APP_PRIVATE_KEY
```

这意味着授权链路经过一个不受我们控制的服务器，且要在本机托管 App 私钥。丢弃。

C 的 Device Flow 则**只与 github.com 通信**，client id 是公开标识符（与 gh CLI 同款模式），
不需要任何 secret。这是我们采用的授权模型：

```
POST https://github.com/login/device/code          → device_code + user_code + interval
POST https://github.com/login/oauth/access_token   → 轮询到 access_token
```

### 2.3 认证分层：复用已有的，才追加

A 的凭据回退链设计得很好，保留其**优先级顺序**，但在最前面加上 dsh 凭据 seam：

1. dsh 凭据 seam（`ctx.credentials.resolve`）——用户在设置里存的，最高优先级
2. 环境变量 `GH_TOKEN` / `GITHUB_TOKEN`
3. gh CLI 自身的登录态（`gh auth status`）
4. git 凭据助手（`git credential fill`，禁用交互提示）
5. Device Flow（本插件自己的授权，token 存回 seam）

前四层都是「机器上本来就能 `git push`」的复用，第五层才是我们新增的能力。

### 2.4 安全模型：保留阻断，丢弃重复实现

B 的 `gitSafetyGuard` 会拦截 shell 里的 `git commit/push/merge`、`reset --hard`、
`git clean`、删分支、force-push。**思路保留**（作为可选配置），但默认关闭：
dsh 已经有自己的权限预设与审批机制，插件再插一层会造成「用户以为批准了却被插件拒绝」
的困惑。我们的默认策略是：破坏性动作要求 `confirm: true`，加上配置总开关。

A 的四道门保留并强化：

1. schema 门——action 闭集枚举
2. needs/check 门——必填参数与自定义校验
3. destructive 门——`confirm: true` **且** `allowDestructive`
4. timeout 门——watch 类动作走 `watchTimeoutMs`

### 2.5 明确丢弃清单

| 丢弃项 | 理由 |
|---|---|
| C 的 5 包 seam 分层 | 单 provider 场景下抽象成本 > 收益 |
| B 的 React 客户端半身（214 KB） | 本期只交付 host 半身；UI 需要单独的 slot 调研与主题令牌核对 |
| C 的 `dsh-ui-github` | 同上 |
| A 的 `github_cli` raw 透传 | 与「argv 数组、无 shell」的安全模型冲突，且模型已有 shell 工具 |
| A 的 `github_codespace` | 使用频率低，且 Codespaces 的 ssh 执行是另一个信任面 |
| 三个仓库的全部 `peerDependencies` 声明 | A 本就没有；B 的 `>=0.1.0-rc.5` 可过但含陈旧注入；C 的 `^0.1.x` 上界是 0.2.0，**不含** 0.2.0-rc.2，会命中 incompatiblePlugin |
| 任何 `prepare` / 构建脚本 | git 源安装时 pnpm 会拦构建脚本，需要用户批准；预编译产物可完全绕开 |

## 三、我们自己的设计

### 3.1 形态

Host-only bundle，零依赖，预编译产物入库，无构建步骤：

```
dsh-github-toolkit/
  package.json          dsh.bundle.patch 指向 patch
  cordis.patch.yml      insert 一行
  index.js              apply/inject/name/Config
  lib/
    config.js           配置解析与钳制
    schema.js           JSON Schema 子集封装（只产出被接受的关键字）
    runner.js           进程运行器（A 的强化版）
    auth.js             凭据分层解析 + Device Flow
    github.js           REST 传输层（C 的强化版）
    workspace.js        工作区 remote 解析（B 的净化版）
    registry.js         domain-table 注册器（4 道门）
    domains/*.js        动作表
  locale/{en,zh}.json   显示元数据
  icon.svg
  test/*.mjs            离线测试
```

### 3.2 相对三个来源的实质改进

1. **A 的 runner 有两处可改**：`spawnRun` 里 `child.kill()` 不带信号，Windows 上对
   git 子进程可能留下孤儿；改为先 `SIGTERM` 再在宽限期后 `SIGKILL`。另外 spill 文件
   在 `closeSpill(false)` 路径上不清理 stderr 已写入的部分——统一为「只有保留时才有 spill 路径」。
2. **A 的 `resolveAuth` 缓存了授权结论**（`authPromise` 只算一次）。凭据 seam 的契约
   明确要求「每次操作重新解析，不得跨操作缓存」。我们的凭据解析不缓存 seam 读取。
3. **C 的 REST 层缺少 5xx 重试**，而 `retry-after` 的语义在 403/429 上被正确处理——
   保留其「限流绝不自动重试」的决策（交回调用方），但给 5xx 加一次有界重试。
4. **C 的 `restTextRequest` 在跟随重定向时正确地不带 Authorization**（避免把 token
   泄漏给对象存储）。这个细节保留并加注释说明为什么。
5. **B 的 `parseGitHubRemote` 只支持 `origin`** 且只认两种 URL 形式。改为：接受
   任意 remote 名、支持 https / ssh:// / git@ 三种形式，并复用 C 的正则思路。

### 3.3 与 dsh 0.2.0-rc.2 的兼容性依据

- 工具注册：`ctx.tools.register({ name, description, parameters, output, execute, presentCall })`
  —— 已用 `cordis_inspect_query` 核对 `tools` 服务的真实签名。
- 工具输出：`output.schema` 走 dsh 的 enforced JSON Schema 子集。该子集**只接受**
  `type / oneOf / properties / required / additionalProperties / items / enum / const`
  加注解关键字 `description / title / default / examples`；`pattern`、`minimum`、
  `format`、`anyOf` 等会以 `UNSUPPORTED_SCHEMA` 拒绝整个定义。所有 schema 经由
  `lib/schema.js` 产出，杜绝漏入。
- 插件导出：`export function apply(ctx, config)` + `export const inject = ['tools']`。
  不混用 default export。**`Config` 已声明**（`lib/config-schema.js` 用
  `@deepseek-ai/schemastery` 构建，`index.js` 导出），因此 Settings 能带校验与说明渲染这些键。
  配置在 `apply()` 里仍用 `resolveConfig()` 归一化，**未知或缺失的键不可能导致激活失败**——
  schema 描述键，不使它们成为必需。

  > **本文档此处曾长期与代码相反。** 原句写「不声明 `Config`，本 bundle 刻意零依赖」，
  > 描述的是加入 schema 之前的早期设计。**一份随包发布的文档说代码没有 `Config`，
  > 而代码有——这正是看板上 FAM-P-06（文档与实现漂移）的一个实例。**
  > 更正于 0.9.7，由独立审计发现。
- 凭据 seam：`ctx.credentials.resolve(ref)` / `.set(ref, value)`，`ref` 需匹配
  `REF_PATTERN`（大写环境变量名形式）。通过 `ctx.get('credentials')` 可选读取，
  因此没有 credentials 服务的 composition 里插件照常激活。
- 包内**声明了 `peerDependencies`**（`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-tools`）。
  这不是可选的美化：DSH 的运行时解析**只在包声明了该依赖时才提供裸包名**，
  不声明就 `ERR_MODULE_NOT_FOUND`。`verify-bundle` 的第 5 项检查现在**要求**这两个 peer 存在。

  > 原句写「不声明任何 `peerDependencies`，因此 `evaluatePluginCompatibility` 返回 `undefined`」，
  > 同样是 schema 之前的旧设计。**与上一条同源、同批更正。**

## 四、实现过程中被真实证据推翻的判断

写实现时做了几个判断，其中两个被实测推翻。记录下来，因为「我以为」和「实测」的差距
正是这类插件最容易出错的地方。

### 4.1 被推翻：`--repo` 必须放在子命令之前

我最初把 `--repo` 用 `splice(1, 0, ...)` 插到子命令后面，理由是「gh 的全局标志必须前置」。
实测 gh 2.89.0：

```
gh pr view 1 --repo cli/cli          exit=0
gh pr view --repo cli/cli 1          exit=0
gh pr --repo cli/cli view 1          exit=0
gh pr list --limit 1 --repo cli/cli  exit=0
```

三种位置全部成功。gh 基于 cobra，持久标志可以出现在任意位置。原设计（追加在末尾）是
对的，我的「修复」反而把标志插进了子命令的定位参数中间。已回退为追加，并留下注释说明
这是实测结论而非推测。

### 4.2 被推翻：`github_api` 应该直连 REST

原计划让 `github_api` 走自己的 fetch 传输层（蒸馏自 kaziii 的 `github-rest`）。真实
只读验证全部失败：

```
node fetch -> api.github.com  FAIL  UNABLE_TO_VERIFY_LEAF_SIGNATURE
gh    api -> api.github.com  exit=0
```

原因是本机 Steam++ 把 `api.github.com` 写入 hosts 指向 127.0.0.1 做 TLS 拦截，
系统证书库信任它，而 Node 自带的 CA 列表不信任。gh 用平台证书库所以能通。

这不只是本机问题：任何有企业 TLS 拦截的环境都会这样。改为走 `gh api` 之后：

- 与另外七个工具共用同一条凭据链和同一套信任配置，不引入第二条网络路径；
- `--paginate` 原生跟随 Link 头；
- 少一个需要独立维护分页/错误映射/重定向的传输实现。

代价是放弃了独立传输层。原先蒸馏自 kaziii 的 `lib/github.js` 因此成为死代码并已删除。

顺带处理了 `gh api` 的两个陷阱：`-f key=value` 会隐含 POST（所以查询参数拼进路径，
让 GET 保持 GET），请求体必须走 `--input -` 而不能进 argv。

### 4.3 保留：Device Flow 的 client id 不能预置

kaziii 的 `DEFAULT_CLIENT_ID = 'Ov23likAeAslKtkPq6Vn'` 是**他们自己的** OAuth App。
照抄会让每个用户的授权都授予给一个他们无法审计、也无法撤销的应用。本插件的默认值
是空字符串，并在 `login` 动作里明确说明如何注册自己的 App。

### 4.4 保留：spill 文件的清理

A 的 `closeSpill(false)` 路径在 stderr 已写入 spill 后仍可能留下文件。本实现统一为
「只有截断的运行为真时才保留 spill 路径」，并用受控实验证明：非截断运行前后临时目录
中的 spill 文件数量不变。

### 4.5 保留：kill 信号升级

A 只调用一次 `child.kill()`（SIGTERM）。一个忽略它的 gh/git 子进程会一直活到宿主回合
结束。本实现升级 SIGTERM → SIGKILL，宽限期 `killGraceMs`（默认 2000ms）。真实测试中
观察到 `signal="SIGTERM"` 且 `timedOut=true`。

### 4.6 保留：guard 的误伤修正

B 的 shell-git guard 用 `/\bgit\s+(?:commit|push|merge)\b/`，会把
`echo "git commit"` 和 `grep -r 'git commit' docs` 一起拦下。本实现改为只在 git 真正
被**调用**的位置匹配（命令开头或 shell 分隔符之后），并保留对 `&&`、`;`、`|` 链式
调用的拦截。

## 五、验证证据

### 5.1 离线套件：63 项，全部通过

`npm test`（先 `tools/ensure-vendor.mjs` 重建依赖、再带解析钩子跑 `node --test`），
不出网、不需要 gh。

覆盖：Config schema 经 Standard Schema 校验（每个字段都有默认值、空行合法；九类非法值
必须被拒——非数字超时、越界超时、零输出上限、畸形 defaultRepo、带多余段的 defaultRepo、
非 ENV 形态的 credentialRef、非字符串 env 值、非布尔开关）、`defineTool` 编译出的 schema
落在强制子集内、参数 DSL 的**类型校验**（数组/整数/布尔/必填/枚举五类错误参数必须被拒且
不执行任何命令）、数组参数不再被展开成单个字符、结果契约对真实返回值逐字段断言、
8 个工具 58 个动作的 argv 构造、破坏性门在 confirm 缺失与开关关闭两种情况下都拒绝、
超时选择、凭据链四层的优先级与降级、Device Flow 轮询状态机（含 slow_down 累加）、
缺 client id 时不发任何请求、guard 的拦截与放行、恶意字符串在 argv 中保持为单个参数。

对照：迁移前为 54 项；新增 9 项集中在 Config 校验与 DSL 类型校验。

### 5.2 真实只读套件：14 项，全部通过

`node test/live-readonly.mjs`，穿过本插件自己的 runner、凭据解析与工作区检测。

```
PASS  runner: gh probe                    gh version 2.89.0
PASS  auth: layered chain                 source=gh-cli login=<account>
PASS  runner: gh api user                 token 经 env 注入，不出现在 argv
PASS  runner: 失败命令报 ok:false 而非抛出
PASS  runner: 超时杀进程                  timedOut=true signal="SIGTERM"
PASS  runner: 超限输出落 spill 文件        1024B 内存 + 925KB spill
PASS  runner: git 禁用交互提示
PASS  workspace: 三种 remote 形式解析，拒绝异源主机
PASS  workspace: 分支名净化拒绝路径穿越
PASS  workspace: 仓库检测不抛错
PASS  api: gh api 返回解析后的 JSON       full_name="cli/cli"
PASS  api: 404 被如实报告而非抛出
PASS  api: 分页聚合                      branches=274
PASS  api: 未认证的公开请求可行
```

### 5.3 端到端激活

对假 dsh ctx 调用 `apply()`：8 个工具注册（auth 4 / repo 9 / pr 14 / issue 8 /
release 7 / actions 10 / search 5 / api 1 个动作），guard 按配置安装，日志无 token 泄漏。
真实执行 `github_repo view cli/cli` 返回 `ok=true`，`data.defaultBranchRef.name="trunk"`。

### 5.4 Bundle manifest 与 patch 用 dsh 自己的解析器验证

从 `app.asar` 提取出 dsh 实际使用的 `yaml@2.9.1`，用**它**解析 `cordis.patch.yml`，
确认解析结果正是预期的 `insert` 结构。这一步是为了排除「用别的 YAML 实现试通了、
真机上却因标签/缩进语义不同而失败」。

### 5.5 安装：junction 形态可行，但**无法解析裸包**（重要）

第一次安装用 `install_bundle` 指向工作区目录，落盘为 junction：

```
dependencies: + dsh-github-toolkit link:D:/dsh/github-toolkit
```

当时我担心它会触发桌面端启动闸门，去读 dsh 实现后发现 `PROFILE_UPGRADE_REQUIRED`
这个错误码在 dsh 里**根本不存在**（那是第三方 README 从别的宿主继承的 Tauri 壳闸门），
`removeLinkProjections()` 也只解除 `.dsh-module-fallback` 下的链接。所以就闸门而言
junction 没问题。

**但它带来了一个我直到重启后才暴露的问题：裸 `@deepseek-ai/*` 导入无法解析。**

进程启动时间证明重启确实发生（`2026-10-14 02:36:47`），重启后：

```
Config.listConfigs  -> status: "inactive"
github_repo         -> unknown tool            （8 个工具全部消失）
install_bundle 返回 -> warnings: ["github-toolkit (dsh-github-toolkit): failed to import"]
```

### 5.6 根因：runtime resolution 只提供**被声明过**的包

用探针 bundle（`D:\dsh\github-probe`，用**动态** import 以免模块整体崩掉）测出：

```
Cannot find package '@deepseek-ai/schemastery' imported from D:\dsh\github-probe\index.js
Cannot find package '@deepseek-ai/dsh-tools'    imported from D:\dsh\github-probe\index.js
```

两个都解析不到。而我此前把 `dsh-our-free-model` 当作「profile bundle 可导入
`@deepseek-ai/*`」的先例——**那个先例是错的**。去读它的源码：

- 它主入口的导入全是 node 内置与相对路径，**没有任何裸包**；
- 唯一含裸包的两个文件是 `adapter/kernel.js` 与 `vendor/channel-pack/pack.js`；
- `kernel.js` 的注释写明：「它是**惰性**导入的……如果某个 composition 无法提供它，
  一个字面量也能保持 attribution 存在」——也就是说它**从不依赖裸导入成功**。

真正的机制在 dsh 的解析表构建代码里：

```js
/** Return dependency names that may be imported by a loader-visible plugin. */
function profileDependencyNames(manifest) {
  return [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})];
}
```

**runtime resolution 只把插件在 `dependencies` 或 `peerDependencies` 里显式声明过的包
供给它。** 而我当初为了躲开兼容性闸门，**刻意不声明任何 peerDependencies**——这正是
插件在重启后无法导入的全部原因。官方《打包与安装插件》页那句「需要与宿主共享实例的
dsh 包同时声明在 peerDependencies 与 devDependencies 中」就是这个意思，我第一遍读时
略过了。

修法是声明 peer，并让范围接纳运行时的 `0.2.0-rc.2`：

```json
"peerDependencies": {
  "@deepseek-ai/schemastery": "^3.18.0",
  "@deepseek-ai/dsh-tools": "^0.2.0-rc.1"
}
```

范围用**真实的 semver**（npm 自带那份）按闸门的完全相同调用验证过：

```
semver.satisfies('0.2.0-rc.2', '^0.2.0-rc.1', {includePrerelease:true}) -> true
semver.satisfies('0.2.0-rc.2', '^0.1.0-rc.6', {includePrerelease:true}) -> false
```

第二行正是 kaziii 那批包用的范围，印证了 §2.5 里「会命中 incompatiblePlugin」的判断。
`@deepseek-ai/schemastery` 不以 `@deepseek-ai/dsh-` 开头，因此**不参与**闸门检查。

### 5.7 安装形态：必须用 tarball，不能用 `link:`

即使声明了 peer，**junction 形态仍然不可用**：实测把插件改成 profile 内的真实目录
（与正常工作的包同形态）后依旧 `failed to import`，因为 runtime resolution 是按
解析表供给的，与目录形态无关——但 `link:` 指向 profile 之外时，连 pnpm 的依赖树都
无法把它算作 profile 自己的内容。

官方分发建议因此是硬要求而非风格偏好：**发布到 npm，或交付 tarball**。

```bash
npm pack --pack-destination D:\dsh\packages
# 然后 install_bundle -> target: D:\dsh\packages\dsh-github-toolkit-0.1.0.tgz
```

代价：tarball 是快照，工作区里的源码改动不会自动生效，需要重新 pack + 安装。

### 5.8 一次数据丢失，以及正确的打包位置

第一次打 tarball 时我把输出放在了**源目录内部**
（`D:\dsh\github-toolkit\dsh-github-toolkit-0.1.0.tgz`），随后从该路径安装。
安装成功后，**源目录内容被清空**（`LastWriteTime` 与那次安装的完成时刻
`02:38:43` 完全一致），`test/` 与 `tools/` 全部丢失。

已核实的事实：

- `remove_bundle` **不是**原因——对本插件的 `remove_bundle` 之后源目录完好（24 个
  文件），对探针 bundle 的 `remove_bundle` 之后其目录也完好。
- 修改发生在**那次 tarball 安装期间**，而该次安装读到了 tarball 才得以成功。
- 我无法进一步确定 pnpm 内部为何消耗源目录；`npm-cache` 里也没有含 `test/`、`tools/`
  的副本（`npm pack` 遵循 `manifest.files`，那两个目录本就不在包内）。

处置：`test/` 与 `tools/` 已按原内容重建，全部套件重新跑通。**现在的做法是把 tarball
打在源目录之外**（`D:\dsh\packages\`），这一条写进 README 以免重演。

### 5.9 已验证：重启后新世代确实生效

按 §5.6 修好 peer 并用 tarball 安装后：

```
install_bundle -> application: applied     warnings: []
Config.listConfigs -> status: "schema"     并投影出完整 JSON Schema（18 个键、
                   credentialRef 的 pattern、timeoutMs 的 minimum/maximum 等）
github_repo action: not-a-real-action
     -> invalid arguments: "action" must be one of ["view","list","branches","clone",
        "create","edit","rename","archive","delete"]
github_auth status -> 正常返回，凭据链解析到 gh-cli / <account>
```

第一项证明两个裸包都解析成功（能投影 Config 说明 `schemastery` 加载了；工具能注册说明
`dsh-tools` 加载了）。第二项是 `defineTool` 的 `ToolArgsError`——**官方 DSL 的参数校验
在真实进程里生效**，同一位置此前返回的是 `Unknown action`。

## 六、按官方文档的合规性核对

用户指出应当先读官方文档而不是只从 `app.asar` 逆向。核对
<https://deepseek-harness.github.io/deepseek-harness/develop/basic/> 及其
tool / config / publish 三页后，发现两处真实偏差并已修正，另有若干条确认一致。

### 6.1 已修正：未声明 Config

官方《插件配置》页的原则是「凡是不同部署可能需要采用不同值的参数，都必须定义为配置
字段」，且配置错误要**在插件加载时响亮失败**。原实现出于「零依赖」的考虑手写
`resolveConfig()`，代价是 `{ timeoutMs: 'abc' }` 这类坏值只在首次命令执行时才暴露，
`defaultRepo` 写成 `not-a-repo` 也只是静默解析不到。

现改为声明 Schemastery `Config`（`lib/config-schema.js`），由 Cordis 在激活时校验并
填充默认值，`lib/config.js` 只保留 schema 不该承担的形态归一化（trim、去尾斜杠）。

三个由实测而非阅读得出的 schema 约束（`tools/probe-schemastery.mjs`）：

1. `@deepseek-ai/schemastery@3.18.4` 的入口是 **Standard Schema** 符号
   `schema['~standard'].validate(input)`，**没有 `schema.parse()`**。dsh 源码里那些
   `schema.parse(...)` 调用是 schemastery 自己的源码/测试文件，不是可用 API。
2. `.default(x)` 取**字面值**，不是工厂。`.default(() => ({}))` 会把函数交给插件。
3. `.pattern()` 必须接受该字段**自己的默认值**。`defaultRepo` 默认为空串表示「从工作区
   remote 推断」，所以 pattern 必须写成 `/^$|^[^\s/]+\/[^\s/]+$/`——原先写成只接受
   `owner/repo` 的版本会让空的 `config: {}` 行校验失败。

### 6.2 已修正：未使用官方的 `defineTool` DSL

官方《开发一个 Tool》页要求用 `defineTool` 与逐属性 DSL
`{ type, required, enum, items, description }`。原实现直接 `ctx.tools.register` 传原始
JSON Schema，官方参考对此明确写着「直接注册的原始 JSON Schema 工具自行负责输入校验」
——也就是说**没有校验**。这留下一个真实缺陷：`labels: "bug"` 会被展开成 `b`、`u`、`g`
三个参数。

现改为 `defineTool`，参数表改用 DSL。实测收益（`tools/probe-define-tool.mjs`，11/11）：

```
defineTool rejects a string passed for an array parameter   -> "labels" must be an array
defineTool rejects a string passed for an integer parameter -> "limit" must be an integer
defineTool rejects a missing required `action`              -> missing required property "action"
defineTool rejects an action outside the enum               -> must be one of [...]
```

两个由实测得出的 DSL 约束：

4. **value schema 不允许 `required`**（编译器以 `allowRequired: false` 运行）。
   因此结果契约不再由 `output.schema` 表达，改由测试对**真实返回值**逐字段断言——
   这比 schema 关键字更强，因为它在跑，而关键字只是声明。
5. **无约束属性需要 `type: 'json'`**。只带 `description` 没有 `type` 的属性会被拒绝。

### 6.3 确认一致的部分

| 官方约定 | 本实现 |
|---|---|
| 插件导出 `apply(ctx)` + `name` + `inject` | 一致，且不混用 default export |
| 资源注册进 `ctx.effect()`，卸载自动清理 | 一致 |
| `execute` 返回规范值，渲染交 `output.render` | 一致 |
| 领域失败写入值，基础设施失败才抛 | 一致（非零 exit 走值，gh 缺失抛 `GhMissingError`） |
| 遵守 `exec.signal` | 一致（timeout 与 abort 双路 kill） |
| `presentCall` 必须是纯函数 | 一致 |
| 组合包 manifest 声明 `dsh.bundle.patch`，patch 行按包名引用 | 一致 |
| 可依赖 `@deepseek-ai/dsh-base` 与安装一致 | 一致（也因此不加任何依赖声明） |

### 6.4 离线测试如何解析 `@deepseek-ai/*`

新实现导入了两个裸包（`schemastery`、`dsh-tools`）。它们在 Harness 内由 launcher 装入
Node 解析器的 runtime resolution 提供，脱离 dsh 进程的 `node` 看不到。两条应对：

- **运行时**：靠 `peerDependencies` 声明（见 §5.6）。这是硬要求——不声明就解析不到，
  插件整体导入失败。**不要**因为「怕触发兼容性闸门」而省略声明；闸门只检查
  `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*` 开头的名字，选一个接纳运行时的范围即可。
- **离线测试**：`tools/asar-vendor.mjs` 从 `app.asar` 逐字节重建 32 个包
  （含 `dependencies` 与 `peerDependencies` 闭包，7.9 MB，约 1 秒），
  `test/resolve-hook.mjs` 只重定向这些裸 `@deepseek-ai/*` 说明符到该目录，插件自身的
  相对导入照常解析。**刻意不做 stub**——stub 只会测到 stub。

### 6.5 三分真七分假：一个被误读的「先例」

本轮最大的教训不是某个 API 用法，而是**把一个未经检验的观察当成了先例**。

我看到 `dsh-our-free-model` 的某些文件里出现 `import Schema from "@deepseek-ai/schemastery"`，
就推断「profile 安装的 bundle 可以导入 `@deepseek-ai/*`」，并据此决定在插件里使用裸导入。
这个推断错在两个地方：一是那些文件并非主入口的静态导入链，二是它用的是**惰性且容忍失败**
的导入。我没有去读它的导入语句，只看到了字符串。

后果：插件在重启后完全无法激活，8 个工具全部消失，而错误信息只有一句
`failed to import`，没有任何细节。真正的机制是我后来在解析表构建代码里找到的那 4 行。

教训写在这里：**「它在某处出现了」不等于「它被支持」。** 观察到字符串之后要读语句，
读语句之后要看它的错误处理，才能判断它是否是一条可依赖的路径。

### 6.6 已修正：locale 显示元数据的形状写错了

用户问「为什么在插件里没看到」，查 `readPluginMeta` 的实现后发现真实原因：

```js
const meta = parsed.meta === void 0 ? void 0 : objectOf(parsed.meta, `${file}: meta`);
dictionaries.set(id, {
  title: textOf(meta?.title, `${file}: meta.title`),
  description: textOf(meta?.description, `${file}: meta.description`)
});
```

解析器读的是 **`meta.title` / `meta.description`**，而我第一版写成扁平的
`{ "title": ..., "description": ... }` —— 于是 `meta` 是 `undefined`，我写的那两个字段
被**完全忽略**，标题回退到 `package.json` 的 `name`。设置页还会把字面包名回退值**缩短**
（去掉 npm scope 与 `dsh-` 前缀），所以卡片上显示的是 **`github-toolkit`**，而不是
「GitHub 工具箱」——难怪看起来像「没有」。

官方 `references/host-plugin.md` 的示例本来就是 `{ "meta": { "title": ..., "description": ... } }`，
我抄成了扁平结构。已修正为 0.1.1。

顺带确认了一个容易踩的点：`dictionariesOf` 会遍历 locale 目录下**所有** `.json`，并要求
文件名是一个合法的语言 id，否则**抛错**。目录里若混入任何别的 json，会让整个
`readPluginMeta` 走进错误分支。本插件的 locale 目录只有 `en.json` 与 `zh.json`。

按真实解析逻辑复核后的结果：

```
resolved title       : {"en":"GitHub Toolkit","zh":"GitHub 工具箱"}
resolved description : {"en":"Typed GitHub tools over the gh CLI: ...","zh":"基于 gh CLI 的类型化 GitHub 工具：..."}
icon declared        : ./icon.svg | exists: true
```

注意这一条**不会让整行消失**（有回退），只是标签降级。所以如果卡片仍然完全看不到，
原因在别处——例如页面缓存了旧的 inventory，或者看的不是「设置 → 插件」这一页。

**已确认（用户复核）：** 修正为 0.1.1 并重装后，刷新页面，设置 → 插件 里正常显示为
「GitHub 工具箱」。此前显示的是被缩短的包名 `github-toolkit`，这正是「没看到」的原因。

## 七、未验证的部分（如实说明）

- **Device Flow 未走通真实授权**：需要用户自己的 OAuth App client id 与浏览器交互。
  轮询状态机用注入的 fetch 完整覆盖，真实 github.com 的授权往返未执行。
- **写操作未执行**：所有验证都是只读的，未创建/合并/删除任何真实资源。
- **PTC mode 下的工具调用未验证**：`defineTool` 使工具可由 `await tools.<name>(args)`
  驱动，但本插件未在 PTC preset 下实测。
- **源码改动不会自动生效**：tarball 是快照，改动需重新 pack + 安装。
- **数据丢失的最终原因未定**：见 §5.8。已知的是它发生在一次「tarball 位于源目录内」
  的安装期间；pnpm 内部行为未能进一步定位。规避方式是 tarball 打在源目录之外。

## 八、未采纳但仍有价值的设计（三个来源仓库删除前的存档）

三个来源仓库的**源码**对本插件已无操作性价值：不依赖、不 vendoring，只在代码注释与
本文中作出处署名。但其中若干**设计**尚未实现，删掉仓库就会丢失。此节按「为什么」而非
「哪一行」记下来，供将来扩展时取用。三者均为 MIT 且是公开仓库，需要源码时可重新 clone。

### 8.1 结构化审查的证据路由（最值得补的一项）

kaziii `packages/github/github/src/review.ts`，251 行，**全部是纯函数且处处有定义**
（同一 diff 总是同样路由）。这正是它值钱的地方：确定性的一半留在 host，判断的一半留给模型。

三个非显然的洞见：

1. **`classifyFile` 的优先级编码了「用途胜过内容」**：`test > docs > types > code > asset`。
   `tests/foo.d.ts` 先算 test，而不是按 `.d.ts` 算类型声明。
2. **`changedLines` 只取 `+`/`-` 行，刻意排除上下文行。** 理由写在原注释里：作者只是顺带
   滚过的一个 `catch`，不该把整次审查路由到「错误处理」维度。这一条是整套路由成立的前提。
3. **路由规则刻意不对称，价值在「排除」而非「平均分配」**：纯文档 PR 不该收到类型审查。
   - `correctness` + `simplification`：有 code/types 变更就上
   - `tests`：有 code 或 test 就上；只有 code 没有 test 时，路由理由本身就是
     「源码变了却没有测试文件被动到」——把「为什么不需要测试」变成一条要回答的清单项
   - `error-handling` / `types` / `comments`：只在**变更行**命中相应探针时才上

另两个决定：六份 checklist 是**常量而不是配置**（原话：一次审查的覆盖面不该随部署而变）；
每条发现被强制要求给出 `path:line`、恰好一个严重度（blocker/major/minor/nit），
以及「哪里错、为何重要、建议怎么改」三者齐全。

**本插件的差距**：`github_pr review` 只是把提交转给 `gh pr review`，没有任何证据聚合。

### 8.2 幂等 PR 创建

kaziii ADR-0004。三步：先查 head/base 对应的 open PR，命中就返回它（`created: false`）；
未命中才 POST；POST 收到 422 且消息含 `already exists` 时**再查一次**并返回竞态赢家。
返回类型把两种结果分开（`created: true|false`），因此调用方能如实呈现「已存在，返回它而
不是重复创建」而不是报错。

**本插件的差距**：`github_pr create` 直接交给 `gh pr create`，重复调用报错而非幂等返回。

### 8.3 确定性 PR 草稿

kaziii `pr-draft.ts`，82 行。一个 commit → 直接用它的 subject 与 body；多个 → 分支名派生
标题加 commit subject 列表；零个 → 只给分支标题。标题派生识别 conventional-commit 前缀
（`docs/root-readme` → `docs: root readme`）。`parseCommitLog` 用 `%x1f` / `%x1e` 作字段与
记录分隔符，使 `git log` 的命令行保持纯 ASCII。

**本插件的差距**：`github_pr create` 要求模型给标题与正文，或交给 `--fill`。

### 8.4 diff / 日志预算

kaziii ADR-0005。核心论点是**执行点必须唯一**：若每个 provider 自行截断，`truncated` 的
语义会随实现漂移，因而不可信。数字由消费方（工具层）持有，截断在接缝处执行一次。细节：
`maxPatchChars` 把溢出的那个 patch 按剩余额度**切一刀**，之后的 patch **只留元数据、
丢掉正文**；日志预算切**尾部**并对齐到行首，唯一例外是额度落在单行内部时保留那半行
（宁可留半行也不留空）。

**本插件的差距**：走 gh CLI + spill 文件，没有按文件数/字符数的预算。

### 8.5 flow-state 四态机

kaziii `flow-state.ts`，163 行。hidden / pr-ready / pr-open / pr-merged，事实全部来自廉价
本地 git 命令。两个值得记的细节：防噪规则按 **cwd 分别缓存 head sha**（一个 dsh 进程服务
多个工作区），无新 commit 就不重算、重复的 hidden 不重复 emit；所有失败路径（无凭据、
非 git、非 GitHub remote、detached HEAD、branch == base、零领先提交）一律 **fold 成
hidden**，让状态栏安静消失而不是报错。

**本插件的差距**：这是给状态栏客户端用的，我们没有客户端半身。

### 8.6 Planckbaka 中我们丢掉的域

| 文件 | 行数 | 内容 | 当初为何丢弃 |
|---|---|---|---|
| `lib/domains/codespace.js` | 120 | Codespaces list/create/ssh 非交互执行/cp/code/stop/rebuild/logs/delete | 使用频率低，且 ssh 执行是另一个信任面 |
| `lib/domains/cli.js` | 54 | raw `gh` 透传，**默认关闭**，`allowRaw: true` 才注册 | 与「argv 数组、无 shell」冲突（但开关思路被我们沿用为 `allowRawApi`） |
| `lib/domains/git.js` | 161 | 本地 git status/add/commit/push/pull/fetch/branch/log/remote；force/amend/delete 要 confirm | 与 dsh 自身 shell 工具重叠，且会绕过宿主权限 |
| `lib/domains/commit.js` | 70 | 只读提交浏览（走 REST） | 被 `github_api` 覆盖 |
| `test/selfcheck.mjs` | 200 | 假 ctx 注册 + argv 断言的离线自检 | 我们的 `test/` 是独立写的同类东西 |

### 8.7 KryptonGao 中我们丢掉的

| 文件 | 行数 | 内容 | 当初为何丢弃 |
|---|---|---|---|
| `src/client/index.tsx` / `styles.ts` / `locales.ts` | 754 / 791 / 255 | React 客户端半身：设置页与侧栏 | 本期只交付 host 半身 |
| `src/github/auth.ts` | 671 | OAuth App + broker 全流程 | **因第三方 broker 与私钥托管而弃用**（见 §2.2） |
| `src/typert.host.ts` + `@Remote` 方法 | — | UI 按钮直连 host，零模型回合 | 依赖客户端半身 |
| `src/git/service.ts` | 197 | 工作区绑定的 git 服务（含安全闸） | 与 §8.6 的 `git.js` 同理 |

### 8.8 评估过但不必保留的

- kaziii 的五包 seam 抽象（provider 注册表、五种选择错误码）：单 provider 场景下抽象成本
  大于收益，判断见 §2.1。
- 各仓库 100% per-file 覆盖率的测试套件：其**方法**（注入 fetch、真实 fixture git 仓库、
  自跳过的 e2e）已被我们的 `test/` 借鉴，代码本身无移植价值。
- 五个 `invariant.ts`：每个包里都是空的 `install` 函数。

## 九、对标官方插件的合规性复核

用户要求「直到能和官方插件媲美」，于是拿**官方工具编写参考全文**与**安装里真实发货的两个
生产级插件**（`@deepseek-ai/dsh-tool-bash`、`@deepseek-ai/dsh-tool-fs`）逐项对。

### 9.1 先看清官方发货什么

```
@deepseek-ai/dsh-tool-bash/     @deepseek-ai/dsh-tool-fs/
  LICENSE          1065 B         LICENSE          1065 B
  README.md       17653 B         README.md       19368 B
  README.zh.md    16362 B         README.zh.md    18234 B
  README.i18n.yaml 4999 B         README.i18n.yaml 5442 B
  lib/index.js    27751 B         lib/index.js    48350 B
  package.json     2334 B         package.json     2374 B
```

对照之下我们**缺 LICENSE、缺中文 README**，README 体量也差一个数量级。这是最容易补、
也最不该缺的一项——manifest 里写着 `"license": "MIT"` 却没有那个文件。

### 9.2 官方用到而我们没用的 `defineTool` 能力

在安装里统计真实用量：`isConcurrencySafe` 5 处、`presentationMeta` 10 处、
`presentResult` 8 处、`deferLoading` 18 处、`jobs.start(` 5 处。逐项判断：

| 能力 | 官方用法 | 我们的处置 |
|---|---|---|
| `isConcurrencySafe` | 只读工具声明 `() => true` | **已补**，且**按动作**判定 |
| `presentResult` | 完成态卡片 | **已补** |
| `output.presentationMeta` | 投影可回放的卡片事实 | **已补**，只投影句柄类字段 |
| `presentCall.kind` | `read`/`search`/`terminal`/`diff` | **已补**（原来一律 `other`） |
| `jobs.start()` + `run_in_background` | 长命令后台化，另有 `promoteOnTimeout` | **已补后台化**；`promoteOnTimeout` 未做，见 §9.5 |
| `deferLoading` | 延迟工具定义加载 | **未采纳**：8 个工具不算多，延迟加载会牺牲可发现性 |
| `tools/pre-execute` 的 `ask` | 写操作走审批 seam | **已补**，见 §9.4 |

### 9.3 只读分类为什么放在「域」而不是「动作」

`isConcurrencySafe` 需要知道哪些动作是读。把 `readOnly: true` 散进 58 个动作里，
改动面大且容易漏；改成每个域一行 `readOnlyActions: [...]`，一处可审计。

代价是这个列表可能与 `destructive` 打架（同一个动作被标成既破坏又可并行读），
所以加了一条交叉校验测试：列表里的每个名字都必须真实存在，且不能是 `destructive`。
这条测试让「一行列表」这个设计变得安全。

两处刻意的排除值得记：`clone`（写本地文件系统，并发会争同一目标目录）与
`release download`（同理）都不算只读；`github_api` **一个都不算**——它读还是写取决于
`method` 参数，而并发分类不允许去解读参数。

### 9.4 破坏性动作：从「模型自称」到「用户同意」

原实现唯一的闸门是 `confirm: true`。这是个真实的安全缺陷：**那是模型自己声明的意图，
不是同意**。模型决定删一个仓库时，它自己就能把这个标志置上，全程没有人被问过。

参考文档对此有明确指引——「尽量不要把部署策略内建到工具中。使用 `tools/pre-execute` 实现
可扩展的允许／拒绝／询问策略」。所以现在破坏性动作走官方审批 seam 发 `{ kind: 'ask' }`，
理由里写明目标（repo/runId 等）。

分层保持三层，最强的在最前：`allowDestructive: false`（硬停，在 `execute` 内）→ 审批询问
→ `confirm: true`（逐次意图）。两个细节：

1. **只有在该调用真的会执行时才询问。** 先 `await next()`，若上游已经 deny，就原样返回
   上游的结果——否则会为一个不可能发生的工作弹一个无效提示。
2. **嵌套 code 分发会跳过 waterfall**，所以第 1、3 层必须留在 `execute` 内部而不是搬到这里。
   这也解释了为什么不能让审批成为唯一防线。

### 9.5 后台任务：一个被测试抓出来的真实缺陷

官方约定（取自 `dsh-tool-bash` README）：`run_in_background: true` 立刻返回 id，
**后台执行不设超时**，用 `job_output` 收集、`job_kill` 终止。

我们实现时犯了一个错，并被自己写的测试当场抓住：第一版在 `jobs.start(...)` **之前**
就把进程启动了。而官方契约写着「运行时会在 `run()` 启动工作前校验 owner 和任务控制器是否
可用」，并且「任何预检拒绝都不留下执行资源」。我的版本若遇到预检失败，会留下一个
**没有 job、`job_list` 看不到、`job_kill` 够不着**的活进程。

改为在 `run()` 回调内启动。两条测试现在把契约钉住：拒绝的预检不得留下进程、
后台工作必须在 `run()` 调用后才开始且带 `noTimeout`。

**未做：`promoteOnTimeout`。** 官方行为是前台命令超时后不杀进程而是转为后台继续跑。
我们的 runner 超时即 SIGTERM→SIGKILL。要支持它，需要让 runner 在超时点把仍有生命的子进程
连同输出流移交给一个 job，这是对 runner 核心循环的改动，本轮未做，如实记录。
`run_in_background` 提供了等价的可用路径：调用方事先声明「这个会久」，就不必依赖事后升格。

### 9.6 补上的验证守卫

`tools/verify-bundle.mjs` 新增五项，都是把这次踩过的坑钉成回归：

1. `LICENSE`/`README.md`/`README.zh.md`/`CHANGELOG.md` 必须存在，且 LICENSE 是完整 MIT 全文；
2. **`locale/*.json` 必须用 `meta` 包裹**——扁平写法会被 `readPluginMeta` 静默忽略，
   卡片回退到被缩短的包名（§6.6 就是这么「消失」的）；
3. **每个裸 `@deepseek-ai/*` 导入都必须已声明**——从真实 import 语句扫描，不依赖手写清单，
   新加的导入无法悄悄溜过（§5.6 的根因）；
4. 每个已注册工具都必须声明 `presentCall`/`presentResult`/`isConcurrencySafe`/
   `presentationMeta`；
5. `run_in_background` 只允许出现在含长动作的域上。

### 9.7 本轮之后的实测状态

| 套件 | 结果 |
|---|---|
| 离线 | 75/75（原 63，新增 12 项对标本轮能力） |
| schemastery / defineTool 探针 | 6/6、12/12 |
| bundle 完整性 | 全部通过（含上述五项新检查） |
| 真实只读 gh | 14/14 |
| 已安装制品 | `dsh-github-toolkit 0.2.0`，`application: applied`，无警告 |

**未完成的一项，如实记录：新能力的实机验证需要重启。** 装上 0.2.0 后，
`Config.listConfigs` 投影出的 schema **没有** `approvalForDestructive` 这个 0.2.0 新增字段，
说明进程里仍是旧的模块世代；因此那次 `run_in_background` 的实机调用走的是旧代码，**不能**
作为新能力的验证。这与官方文档一致——替换已安装的包需要重启才能加载新的 JavaScript 模块
世代。（上一次 `peerDependencies` 修复能立即生效，是因为当时插件处于导入失败状态，
没有可缓存的旧世代。）

重启后要复核的三项：

1. `Config.listConfigs` 的 schema 中应出现 `approvalForDestructive`；
2. `github_actions { action: "runWatch", run_in_background: true, ... }` 应返回
   `data: { kind: "background", jobId: "github-N" }`，而不是前台执行；
3. 一个破坏性动作（如 `github_repo delete` 加 `confirm: true`）应弹出审批询问。

### 9.8 重启后的复核结果

**第 1、3 项已通过：**

- `Config.listConfigs` 投影出的 schema 中**出现了** `approvalForDestructive`，
  证明新的 JavaScript 模块世代确实加载了。
- `github_repo { action: "delete", confirm: true, repo: "this-org-does-not-exist-xyz/nope" }`
  返回 `Error: the user rejected tool "github_repo"` —— 审批 seam 在 **`execute` 之前**
  拒绝（本会话审批被自动拒绝）。此前同样的调用会直接跑 `gh repo delete ... --yes` 并返回
  404。目标刻意选了一个不存在的仓库，所以两种结果都无害。

**第 2 项发现了一个真实 bug，已修：**

```
Error: session "[object Object]" has no live agent (background job owner must be live)
```

两个结论：

1. **后台分支确实触发了**——错误来自 `jobs.start` 的预检，不是静默前台执行。
2. **`owner` 传错了类型。** 读 `resolveOwner` 的实现：

   ```js
   resolveOwner(session) {
     const agents = this.selfCtx.get("agents");
     const owner = agents.get(session);
     if (owner === void 0) throw new Error(`session "${session}" has no live agent ...`);
   }
   ```

   它要的是 **SessionId**，用 `agents.get(session)` 反查活着的 Agent。而 `exec.agent`
   是 **Agent 对象本身**，session id 在 `agent.id` 上（安装里
   `agents.get(this.agent.id) !== this.agent` 这条断言印证了这点）。参考文档写的
   `owner: exec.agent` 是简写，照抄会把对象塞进去。现在 `ownerSessionOf()` 同时接受
   字符串与对象两种形状，未知形状降级为**无主任务**（`resolveOwner` 对 `undefined`
   提前返回，是受支持的状态），而不是留一个坏 owner。

**这次预检失败顺带验证了 §9.5 那个修复的价值：** `jobs.start` 在预检阶段就抛了，
而**没有留下任何进程**——因为启动被放在 `run()` 内。如果还是第一版（在 `jobs.start`
之前启动），这次真机上就会多出一个没有任何 job 能触及的 `gh` 进程。

**同一轮补上的第二处：** 原先既没有给 `JobSpec.output` 提供源，也没有用
`JobHandle.append`。`JobHandle` 的契约是：

```ts
export interface JobHandle {
  readonly id: JobId;
  append(text: string, options?: JobAppendOptions): void;
  updateProgress(line: string): void;
}
```

不接它的话，后台任务会返回一个 id，而 `job_output` **读不到任何内容**——对一个为了
「稍后再读日志」而存在的功能来说，这等于没实现。现在 runner 的 chunk sink 会把输出按
到达顺序转发给 `job.append`（回调抛错被吞掉：ring 属于注册表，一个满的 ring 不该让用户
正在等待的进程失败），并把命令作为 progress 上报。

另一处顺带核实：`kind` 在运行时**只校验非空字符串**
（`if (spec.kind.length === 0) throw new Error("invalid job kind: ...")`），且
`JobKindMap` 在官方文档里被描述为「可合并扩展」，所以自定的 `kind: "github"` 合法，
任务 id 形如 `github-1`。

### 9.9 复核之后的最终状态

**第 2 项已通过（第二次重启后）。** 装上含 owner 修复与输出流的版本后：

```
github_actions { action: "runWatch", repo: "cli/cli", runId: "38447288363", run_in_background: true }
  -> $ gh run watch 38447288363 --repo cli/cli
     started background job github-1

job_list   -> github-1 [github] completed — gh run watch 38447288363 --repo cli/cli
job_output -> Run Triage Scheduled Tasks (38447288363) has already completed with 'success'
              [status: completed, exit 0 in 1480ms]

并收到注册表的完成通知：
  background job github-1 (github: gh run watch ...) finished [status: completed, exit 0 in 1480ms].
```

四项都得到印证：`kind: "github"` 被接受且 id 为 `<kind>-N` 形式；owner 解析成功；
**输出环确实带回了 `gh` 的真实输出**（证明 `job.append` 的流式转发生效——否则 `job_output`
只能读到状态、读不到内容）；注册表的完成通知路径也正常。

| 套件 | 结果 |
|---|---|
| 离线 | **79/79** |
| schemastery / defineTool 探针 | 6/6、12/12 |
| bundle 完整性 | 全部通过 |
| 真实只读 gh | 14/14 |
| 实机：Config schema 含 `approvalForDestructive` | ✅ 新世代已加载 |
| 实机：破坏性动作被审批 seam 在 `execute` 前拦截 | ✅ |
| 实机：后台任务受理、列出、读取输出、完成通知 | ✅ |

留待将来、已如实记录的两项：**`promoteOnTimeout`**（§9.5，需要改 runner 核心循环）与
**客户端半身**（无设置页/状态栏卡片，卡片走通用路径）。`deferLoading` 是评估后未采纳
（§9.2），PTC mode 未实测（§七）。

## 十、一个提问暴露出的验证盲区

用户问「为什么插件不能选择 github 分支呢」。查下去发现**五个动作从来没有成功过**——
它们在真实 `gh` 上必然失败，而我的全套测试都是绿的。

### 10.1 找到的缺陷

| # | 缺陷 | 后果 |
|---|---|---|
| 1 | `repo branches` 声明了 `json: 'name,commit'` 却在构造 `gh api` 命令 | 注册表追加 `--json`，而 `gh api` 没有这个标志 → 每次 `unknown flag: --json` |
| 2 | `repo branches` 完全忽略自己的 `branch` 参数 | 帮助文字承诺「inspect one when `branch` is given」，代码从未读过它 |
| 3 | `repo clone` 把 `--branch` 传给 `gh repo clone` | 那是 GIT 标志，必须放在 `--` 之后，否则 gh 报未知标志 |
| 4 | `repo view` 没有 `branch` 参数 | `gh repo view --branch` 存在却没暴露 |
| 5 | `pr list` 没有 `--base`/`--head` | 无法按分支筛选 PR |
| 6 | `pr checkout` 没有 `--branch` | 无法指定本地分支名 |
| 7 | `issue develop` 没有 `--base` | 无法指定从哪个分支开 |
| 8 | `release list` 要了 `url` | 该命令不返回 url → 每次 `Unknown JSON field` |
| 9 | `search repos` 要了 `nameWithOwner`/`stargazerCount`/`primaryLanguage` | 那是 `gh repo list` 的词表；`gh search repos` 用 `fullName`/`stargazersCount`/`language` |
| 10 | `search commits` 要了扁平的 `message`/`committedDate` | 该命令把它们放在 `commit`/`committer` 子对象里 |
| 11 | 五个 `search` 动作都把整个查询当作**一个**参数 | gh 会为每个位置参数**分别加引号**再拼接，整段于是变成一个被引用的词 → 任何带限定符的查询都 `Invalid search query` |

第 1、8、9、10、11 项意味着：**`repo branches`、`release list`、`search repos`、
`search commits`，以及所有带限定符的搜索，从来没有返回过一次数据。**

### 10.2 为什么我的验证没抓到

诚实回答这个问题，因为它比缺陷本身更重要：

1. **离线测试只断言我挑选的那些 argv。** 没被挑选的动作等于没测。
2. **实机套件测的是 `lib/` 模块，不是完整动作。** 14 项检查覆盖 runner、凭据链、remote
   解析、`gh api` 通路——全是底层，没有任何一项去跑一个**动作**。
3. **`verify-bundle` 检查的是结构与声明**，它证明不了 argv 能被 gh 接受。

三层加起来的效果是：**结构正确、模块正确，而动作可以整体是坏的，却全绿。**

### 10.3 补上的守卫

在实机套件里新增「每个只读动作都真的跑一遍」：把每个只读动作通过**真实注册表**、
用**真实 runner** 调到**真实 gh**，断言 gh 不拒绝这条命令行。

断言的措辞刻意收窄成「不是用法错误」而不是「成功」——对任意资源做只读探测本来就会 404，
若为「pull request 1 不存在」判断失败，这条检查很快会被所有人忽略。用法错误的词表逐步
补齐过两次：先是 `unknown flag`；加入 `Unknown JSON field` 后又抓出 3 个；加入
`Invalid search query` 后又抓出 5 个。

**这条检查就是本可以避免这 11 个缺陷的东西。** 现在 21 个探针，取代原来的 0 个。

### 10.4 另一个提醒：同名不同义

`gh repo list` 与 `gh search repos` 对同一概念用**两套名字**：

| 概念 | `repo list` | `search repos` |
|---|---|---|
| 全名 | `nameWithOwner` | `fullName` |
| 星标数 | `stargazerCount` | `stargazersCount`（多个 s） |
| 主语言 | `primaryLanguage` | `language` |

字段名不能跨命令复用。这类知识只能靠对真实 gh 逐个核对得到——文档里没有这张表，它是用
`--json __bogus__` 让 gh 自己报出 `Available fields:` 换来的。

### 10.5 一条只能实测的知识

分支名里的 `/` **必须原样放进 API 路径**：

```
gh api "repos/cli/cli/branches/af/12325-pr-view-project-null"        -> 200
gh api "repos/cli/cli/branches/af%2F12325-pr-view-project-null"      -> 404
```

百分号编码直觉上更"安全"，实际会 404。所以路径里的分支名原样拼接，安全性改由
`safeBranchName` 前置校验保证（拒绝 `..`、前导点、前后分隔符——这些才是能让名称多出路径
段的形状），并且校验接在动作的 `check` 上，被拒的调用不会发出任何请求。

### 10.6 重启后的实机复核（0.2.1）

七项，全部在真实进程里通过，覆盖了此前从未成功过的每一条路径：

| 调用 | 结果 |
|---|---|
| `github_repo branches`（列表） | `gh api repos/cli/cli/branches?per_page=3` → 200 |
| `github_repo branches` + `branch: trunk` | `gh api repos/cli/cli/branches/trunk` → 200，含 `protected: true` 与保护规则 |
| `github_repo view` + `branch: trunk` | `gh repo view cli/cli --branch trunk --json …` → 200 |
| `github_search issues` + `repo:cli/cli is:open` | 查询被拆成两个参数 → 200，3 条真实 issue |
| `github_search commits` + `repo:cli/cli fix` | `--json sha,commit,author,committer,repository,url` → 200 |
| `github_release list` | `--json …isLatest,publishedAt`（无 `url`）→ 200 |
| `github_pr list` + `base: trunk` | `gh pr list --base trunk` → 200，2 条真实 PR |

未实机执行的只有 `repo clone` 与 `issue develop`——两者都是写操作，**刻意不执行**。
它们的 argv 由离线断言与 `gh --help` 的真实标志表覆盖，这一点如实说明。






