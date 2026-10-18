# Changelog

## 2.0.0 — 改名 + 产品面补齐

**改名为 `dsh-github-gate`。** 原名叫 `dsh-github-toolkit`，而市场里已有一个同名、同 topics、
更早创建的插件（`QDchuan/dsh-github-toolkit`，18 个工具 + Web 设置页）。在市场里扫过去，我们会
看起来像它的功能更少的旧版本。名字改成 `-gate`：仍含 github（可被搜到），而 "gate" 正是真正的
差异点——每个改状态的动作都过一道审批门。

### 为什么值得改，而不是辩解

对比是量出来的，不是感觉出来的：

| | 同名插件 | 我们（2.0 之前） |
|---|---|---|
| README 截图 / 徽章 | 1 / 3 | **0 / 0** |
| 一行安装 | `install.ps1` | **无（下载 tgz）** |
| 配置方式 | **GUI 设置页** | YAML 编辑 |
| issue 模板 / dependabot / 发布流水线 | 有 | **全无** |
| 错误提示 | 401/403/404/422 各自说清 | 只有认证一条 |
| 仓库文件数 | 18 | 85 |
| 测试代码量 | ~40 KB | **~160 KB** |

结论很直白：**他们更像一个产品，我们更像一套验证过度的工具。** 用户第一眼看到的是前者。
2.0 补的就是那一半，同时没有丢掉这一半。

### 新增

- **Settings → Plugins → GitHub 设置页**（`settings.plugins.tab` 槽位）。显示凭据是否已配置、
  来自哪一层、账号、引用名与版本；密码框写入凭据存储；**Test connection** 走一次真实
  `gh api user`。三条路由全部 `requireGate` 且**缺失 connection 时 fail-closed 403**——
  一个写凭据的页面不能对无法判定身份的调用者开放。页面**无法读回 token**。
- **`lib/format.js`**：统一的失败提示词汇。401 / 403 配额 / 403 SAML / scope 不足 / 404 /
  422 / 409 / 网络 / gh 缺失，各自给出**该做什么**；无法识别的失败**返回 undefined**，
  而不是一句"出错了"——泛泛的提示会教人跳过提示。
- **`lib/http-json.js`**：`sendJson` / `readJsonBody` 去重（原本分支路由与设置路由各一份）。
- **`install.ps1` / `install.sh`**：下载 + **按 GitHub 公布的 sha256 校验** + 打印安装路径。
  实测通过：下载 216827 字节、摘要比对一致。脚本**故意不安装**——安装要改 profile 并需审批。
- **`.github/`**：issue 模板（bug / feature，字段按本插件自己的诊断设计）、PR 模板（含行为契约
  与写动作分类勾选）、`dependabot.yml`、**tag 触发的 `release.yml`**（校验 tag 与 package.json
  版本一致后打包发布）。
- **`PRIVACY.md`**：逐条列出数据去哪、存哪、怎么删。
- **`docs/roadmap.md`**：做什么、不做什么，以及不做的理由。
- **`npm` 元数据**：`repository` / `homepage` / `bugs` / `engines` 补齐。

### 改名

29 个文件、约 80 处引用：包名、`cordis.patch.yml` 行、路由前缀 `/dsh-github-gate/*`、
skill provider 名、日志前缀、诊断字段、工具名（`github_*` **不变**，它们是模型看到的接口）。

### 新增测试

| 套件 | 内容 |
|---|---|
| `test/settings.test.mjs` | 13 条：fail-closed（无 connection / 401 / 403 / 抛异常 / 未知值）、不回显 token、写 seam、真实 `api user` 调用、method 校验、effect 归属 |
| `test/client.test.mjs` | 5 条：用假 loader + 假 React 真实加载 `client.js`，验证两个槽位各自注册、两个组件**构建元素树而不抛异常**、路由只落在本插件命名空间 |

**这两组测试存在的原因**：浏览器半边和 HTTP 路由是 Node 测试体系覆盖不到的地方，而它们恰好
是最容易"看起来对、加载就炸"的部分。设置页第一次被测时，假 ctx 缺 `ctx.on`，
`installWhenAvailable` 静默跳过安装——测试报 0 条路由，看起来像注册 bug。

### 验证

| 套件 | 结果 |
|---|---|
| 离线测试 | **176/176**（原 158，新增 18） |
| 参数覆盖 | **211/211**，9 工具，0 NOT covered |
| 行为快照 | 180/180 确定性一致 |
| bundle / 引导 / 编码 | 全通过 |
| `install.ps1` 实机 | 下载 + 摘要校验通过 |

---

## 1.7.1 — 修正 1.7.0 里「必须重启」这个说法（实测推翻了它）

**1.7.0 声称安装后「必须重启才加载新世代」。本机实测把这句话推翻了，所以改掉。**

### 观测

安装 1.7.0 之前，运行中的进程服务 1.6.1（8 个工具、6 条提示规则、没有 `updateCheck` 等键）。
执行 `plugin_manager install_bundle`（返回 `application: applied`）之后，**未重启**，立即：

| 检查 | 1.6.1 应为 | 实测 |
|---|---|---|
| `Tool.listTools` 的 `github_*` 数量 | 8 | **9**（含 `github_update`，带 4 个参数） |
| `Config.listConfigs` 的投影 schema 键 | 无 `updateCheck` | **有** `updateCheck` / `updateRepo` / `updateChannel` / `updateCacheDir` |
| 注入的系统提示词规则数 | 6 | **7**（第 7 条正是新增的更新规则） |

三项都是新世代才存在的产物，所以插件管理器在安装时**重新激活了 entry**，新模块世代已经
在服务，不需要重启。

### 但这不是「永远不用重启」

同一环境早些时候（本次会话记录的 §9.7）装 0.2.0 后，投影的 `Config` schema **没有**出现
新增字段，直到重启。两次观测相反，说明「要不要重启」取决于具体安装路径与加载器行为，
而不是一个可以写死的事实。

所以现在的说法是**条件式**的，并且给出可执行的验证方式：

- 重启是加载新世代的**可靠**方式；
- 但不要假设结果 —— 用**只在新版本存在**的工具或 Config 键去验证；
- **已安装的 `package.json` 不能作为证据**：pnpm 会在模块可能仍未重载时就替换它，
  于是 `pluginVersion()` 会报新版本号而运行的是旧代码。

### 改动

- `github_update` 的 `stage` 结果：`next.restartRequired` 从 `true` 改为
  **`'unverified'`**，输出文本从「两步」改为「一步 + 请验证运行世代」。
- 工具描述、提示词第 7 条、README、`lib/update.js` 的模块文档同步为条件式表述。
- 新增测试断言 `restartRequired === 'unverified'` 且输出包含验证指引；
  实机探针同步。

### 为什么值得发一个版本

因为这行字会直接改变助手的行为：原来第 7 条要求「重启前绝不要声称新版本已激活」，
而实际上新版本可能**已经**激活 —— 那会让模型拒绝承认一件已经发生的事实。文档错了，
行为就跟着错。

---

## 1.7.0 — 自动更新：检查与暂存，安装和重启留给平台

**新增 `github_update` 工具，两个动作：`check` 报告是否有新版本，`stage` 下载并校验其
sha256，返回可安装的路径。**

### 为什么不做「全自动安装 + 自动重启」

三条实测约束决定了边界，都不是猜的：

1. **这个环境里 Node 的 `fetch` 到不了 github.com。** TLS 被代理拦截、OS 信任但 Node 的
   内置 CA 不信任，`fetch` 报 `UNABLE_TO_VERIFY_LEAF_SIGNATURE`，而 `gh` 因为用平台信任库
   正常。所以本功能的每一次网络调用都走 `gh` —— 和 `github_api` 早就记录过的同一个理由。
   设计前先跑了一遍：匿名 `fetch` 失败、`gh api` 成功（5000/小时）。
2. **替换已安装的包必须重启才生效。** Node 早已 import 了旧模块，写新文件不改变运行中的
   世代。本会话直接观测到：装完新版后投影出的 `Config` schema 仍是旧的，直到 Host 重启。
3. **安装由 Harness 插件管理器拥有。** `install_bundle` 会重写 profile 的 `package.json`、
   跑 pnpm、应用 patch 行。插件自己去改 profile 会让依赖 spec、lockfile、patch 行三者不一致
   —— 而且会绕过平台已经设好的审批点，那正是「允许下载的代码运行」的那道门。

所以能做且该做的两件事在这里，不能做的两件事留给平台：

```
check   → 有没有新版本？                      （只读）
stage   → 下载并校验摘要                       （只写一个本地文件）
install → plugin_manager install_bundle        （平台，需审批）
restart → 用户                                 （平台）
```

### `check`

- 读 `releases/latest`（`channel: stable`）或 releases 列表（`channel: latest`，含预发布）。
- 报告 installed / latest / 关系（`newer` / `same` / `older` / `unknown`）、release URL、
  资产名与大小、GitHub 公布的摘要、以及已暂存的文件。
- **`unknown` 是独立答案**：版本无法解析时不假装「已是最新」。源码 checkout 会比发布版新，
  这种情况明确说「installed is AHEAD」，不提示降级。

### `stage`

- `gh release download` 下载，然后**用 GitHub 在 release payload 里公布的 `sha256:` 摘要
  校验**。传输成功不等于文件正确，所以校验不是装饰。
- 三态而非两态：`match` / `mismatch` / **`unverified`**（该 release 没公布摘要）。
  把「没有摘要可对」当成通过，会让这项检查沦为摆设。
- 摘要不匹配时**拒绝暂存**并给出两个哈希值。
- 已暂存且校验通过的文件直接复用（`reused: true`），避免重复下载；`force: true` 强制重下。
- 结果里明确写 `installed: false` 和 `next.restartRequired: true`，并输出剩余两步。

### 激活时的提示（可选）

`updateCheck: true` 时，激活阶段做一次检查，**24 小时缓存**，有新版只打印一行。
**默认关闭** —— 与 `blockShellGit` 同一条理由：不在用户没要求时联网。工具本身随时可用。

### 新增配置

| 键 | 默认 | 含义 |
|---|---|---|
| `updateCheck` | `false` | 激活时检查一次（24h 缓存）并打印一行提示 |
| `updateRepo` | `""` | 读取 release 的仓库，空则本项目 |
| `updateChannel` | `stable` | `stable` 忽略预发布；`latest` 取其最新 |
| `updateCacheDir` | `""` | 暂存目录，空则系统 temp |

### 验证

| 套件 | 结果 |
|---|---|
| 离线测试 | **157/157**（新增 17 条更新测试） |
| 参数覆盖 | **211/211**，9 个工具，0 NOT covered |
| 行为快照 | **180/180** 确定性一致（新增 4 条，均不触网） |
| bundle / 引导 / 编码 | 全通过 |
| **实机端到端**（真实 GitHub release） | **11/11**：真实读取、下载、摘要 `match`、复用、篡改检出 |

实机探针 `tools/probe-update-live.mjs` 拿真实的 `1273984347/dsh-github-toolkit` 跑：
下载 203 KB 资产、校验出的摘要与 GitHub 公布的 `sha256:1b2c234e…` 一致、篡改一个字节后
校验立刻变 `mismatch`。这是「暂存值得做」的证据。

### 未做，以及为什么

- **自动安装**：需要写 profile（沙箱之外）且绕过审批，见约束 3。
- **自动重启**：插件无法重启承载它的进程；能做到的只有「提示用户重启」。
- **签名校验**：Release 资产由 GitHub 提供摘要，已足够防传输损坏/替换。真正的供应链签名
  需要维护者密钥，超出本插件范围。

---

## 1.6.3 — R4：结构化重构（行为零变化）

**这一轮不改任何行为。唯一的目标是让代码可读、可维护、可扩展，并用可执行的证据证明
「没改行为」不是一个声明。**

判断标准不是「更像教科书」，而是三个可测量的问题：一个新人读 `execute` 需要几分钟？
同一个决定在两处出现过几次？一次改动要碰几个文件才能确认安全？

### 为什么敢说「行为零变化」

重构最大的风险是「顺手修了一下」。所以先建了一张网再动刀：

- **`tools/snapshot-behaviour.mjs`** —— 驱动全部 8 个工具的每个动作 × 四种参数组合
  （minimal / maximal / 无 confirm / 有 confirm），记录**精确的 argv、结果值、拒绝文案**，
  共 **176 个快照**。重构前生成 `before.json`，每完成一步 `--compare` 一次。
  176/176 全部一致才继续下一步。
- 计时字段（探针里的 `0 ms` / `1 ms`）在比较前归一化——第一次比较就因为这 1 ms
  报了一个假差异，而一个会误报的工具会教人忽略它。

这条网比测试更严：测试只检查「有人想到要检查的」，快照检查「没人写下来的」。

### 提取的公共模块

| 新模块 | 消除了什么 |
|---|---|
| `lib/result.js` | 结果值形状手写了 **5 处**（registry 的拒绝、`github_api` 的拒绝、`github_auth` 的两条自定义路径、后台任务句柄）。5 份副本 = 5 次漏掉 `truncated` 的机会。现在 `rejection()` / `completed()` 两个构造器 + `missingResultKeys()` 一处校验 |
| `lib/argv.js` | 「优先 `--body-file`，否则 `--body`」这个决定在 issue / pr / release 里重复了 **10 次**，其中一处还多一个空串兜底。`pushTextSource()` 一处表达；顺带统一了「argv 每个元素必须是字符串」 |
| `lib/result.js` 的 `RESULT_KEYS` | 与 `lib/schema.js` 里的同名常量是两份拷贝——**一份契约两个出处**。`schema.js` 改为重导出 |

### 拆开的过长函数

| 函数 | 之前 | 之后 | 拆法 |
|---|---|---|---|
| `registry.js` 的 `execute` | 173 行 | 67 行 | 按职责抽出 7 个阶段函数：`checkGates`（第 1+2 道门）、`resolveActionRepo`、`appendRegistryFlags`、`timeoutFor`、`domainExecutable`、`runArgv`、`admitBackground`、`finalizeRun` |
| `registry.js` 的 `registerDomainTools` | 118 行 | 29 行 | `defineTool` 的 92 行配置对象 → `defineDomainTool()` |
| `client-bridge.js` 的 `installClientBridge` | 308 行 | 30 行 | 四个路由处理器 → `branchHandler` / `diagnosticsHandler` / `branchesHandler` / `switchHandler`；诊断响应体 → `diagnosticsPayload()`；重复的「鉴权 + 方法检查」→ `refuseIfUntrusted` / `refuseIfMethod` / `admitRequest` |
| `index.js` 的 `apply` | 190 行 | 100 行 | 70 行依赖对象 → `buildDeps()`；shell-git 守卫 → `installShellGitGuard()` |

`apply` 现在读起来是激活发生的顺序：解析配置 → 凭据环境 → runner → 探针 → deps →
注册工具 → 引导 → 审批门 → 路由 → 守卫。

### 消除的重复

- **`executableFor`**：`registry.js` 和 `runner.js` 各有一份 `cfg.ghPath !== '' ? … : 'gh'`。
  两份拼写是「后台任务标签写了一个实际没跑的二进制」的成因。现由 `runner.js` 单一出口。
- **孤儿 JSDoc 两处**：`client-bridge.js` 有一段描述已删除函数的文档块；`schema.js` 中
  `RESULT_VALUE_SCHEMA` 的文档被 `requiredStr` 系列隔开，成了无主注释。都已归位。
- 逐字节对比修复前的安装态，确认没有其他残留。

### 命名与风格

- `executableFor(domain, cfg)` → `domainExecutable(domain, cfg)`（registry 侧），
  与 runner 的 `executableFor(cfg, kind)` 区分开：一个是「这个 domain 用哪个可执行文件」，
  一个是「某类二进制叫什么」。
- `failure()` / `fail()` 两个别名原来各有一份完整实现，现在都是 `rejection()` 的别名，
  注释说明了为什么保留短名（让 `execute` 里的提前返回一眼可辨）。

### 新增的守卫

- **`test/r3.test.mjs` 的「依赖袋真的接线了」**：`deps` 的每个方法都是 `apply` 局部变量的
  闭包，**重构时移进 helper 很容易让它引用到作用域里已不存在的名字**。
  `github_auth status` 确实在重构中途抛了 `ReferenceError: credentialEnv is not defined`，
  而且激活、注册、其余测试全绿——因为闭包只有在被调用时才求值。现在三个方法各被调用一次。
- **`pushTextSource` 的两条**：一条钉住优先级与类型（含 `0` 不能被丢弃、空串仍是「已提供」），
  一条驱动真实动作断言 `--body` / `--notes` 真的按新写法产出。helper 正确但没被使用，
  单测照样过——所以第二条是必要的。

### 验证

| 套件 | 结果 |
|---|---|
| 行为快照（重构前 vs 重构后） | **176/176 一致** |
| 离线测试 | 140/140（原 138，新增 2） |
| 参数覆盖 | 203/203 |
| bundle 完整性 / 引导 / 编码 | 全通过 |
| 真实 gh `--help` 解析 | 80/80 |
| positional 数量 vs gh USAGE | 50/50 |

---

## 1.6.2 — R3：七个「不可能成功」的动作和八个没有门的写操作

**这一轮的全部缺陷都有一个共同点：离线测试全绿，而真实 `gh` 拒绝每一条命令。**
R2 的结论「`verify` 覆盖不到 `client.js`，也覆盖不到 `gh` 是否接受这些 argv」在这一轮
被完整兑现——八个域里有七个动作**在任何输入下都无法成功**，因为它们传了不存在的
flag、超量的 positional，或者漏了必需的那个。

### P0 — 一个动作三个错，静默失败

- **`repo rename` 传了两个 positional 且缺 `--yes`。** `gh repo rename [<new-name>]`
  只接受一个，`rename new-name a/b` 报 `accepts at most 1 arg(s), received 2`；
  即使数量对了，非交互下还要 `--yes`。现在：`repo rename <newName> --yes --repo <repo>`。
- **`repo archive` 缺 `--yes`。** 同样报 `--yes required when not running
  interactively`。而 `archive` **没有 `--repo` flag**（与 `rename` 不同）——
  这一点是修完之后才发现的：第一次修复给 `archive`/`delete` 也加了 `--repo`，
  被 `probe-argv` 立刻以 `unknown flag: --repo` 打回。三个动作的形态互不相同，
  照抄一个到另一个就是这次的教训。
- **`repo create` 传了 gh 不存在的 flag。** `--add-topic` 和 `--fork` 都属于
  `gh repo edit` / `gh repo fork`，报 `unknown flag`；fork 已有独立子命令。
  另有一个悬空 `--source`：`repo === ''` 时 push 空串再被 `.filter` 删掉，
  留下 `flag needs an argument`。
- **`pr review` 从不提交评审。** argv 只有 `pr review <n> [--body]`，而 gh 要求
  `--approve` / `--comment` / `--request-changes` 三选一，
  `pr review 1 --body x` 报 `--body unsupported without --approve,
  --request-changes, or --comment`。新增 `reviewAction` 参数（必填），
  映射到真实 flag。
- **`actions runDelete` 传了 `--yes`。** `gh run delete` 只有 `--help` 和 `--repo`。
- **`pr status` 传了 positional。** `gh pr status [flags]` 不接受任何，
  报 `unknown argument "123"`。`status` 改为只读当前分支，参数描述同步。
- **`repo list` 传了 `--affiliation`。** gh repo list 用 `<owner>` positional +
  `--fork` / `--archived` 过滤。
- **`release download` 带 asset 时两个 positional。** gh 只接受一个；
  asset 改走 `--pattern`。

### P0 — 安全

- **`github_api` 的 `..` 没有被拦。** `validateApiPath` 严格实现了「必须相对」，
  但 `gh api` 会先规范化路径：实测 `/repos/../../../../user` 成功，
  `/repos/../rate_limit` 成功。同主机内的端点逃逸完全敞开，而读侧没有任何门。
  现在路径含 `..` 一律拒绝。

### P1 — 三层防线漏了两层

- **八个写操作没有标 `destructive`**：`issue comment/reopen/edit/develop`、
  `pr comment/ready/edit`。它们既不经过 `confirm` 门，也不经过审批 seam。
  最典型的是 `issue develop`——它在远端建分支并本地 checkout，是纯写操作却无任何门。
  旧测试的循环体第一行就是 `if (action.destructive !== true) continue`，
  **结构上无法发现漏标**。新增一条守卫：任何非读动作必须出现在
  「destructive」或「local-only」清单里，否则构建失败。
- **`github_api` 完全绕过审批门。** 它的 `request` 动作无法静态分类
  （GET 读、POST 写），于是 11 个动作装了审批，唯独这个最不受约束的逃生舱没有。
  现在按 `method` 动态判断，`POST/PATCH/PUT/DELETE` 触发 ask。
- **`isOwnerRepo` 不拦 `..`**：配合 `repos/${repo}/branches/...` 可构造同型路径遍历。

### P2 — 文档/提示词与实现不符

- **系统提示声称 `github_issue` 的 `close` 会弹审批**，而它不是 destructive。
  模型据此认为「用户已经同意过」。已修正实现（`close` 标 destructive），
  并新增守卫：解析提示词第 4 条规则，断言其中每个动作都在审批映射里。
- **`firstWord` 解析 `gh --version` 失败。** 版本是第三个 token
  （`gh version 2.89.0 (...)`），代码取第二个，回退到 `"gh"`，
  `parseInt("gh")` 是 NaN，于是 `isOlderThan` **永远返回 false**——
  `minGhVersion` 这个配置项在任何真实输入下都不会生效。逻辑移到
  `lib/version.js`，改为扫描第一个形如版本号的 token，并补齐测试。
- **`cfg.env` 里的凭据不被识别。** `resolveToken`/`describeAuth` 读 `process.env`，
  而 runner 用 `process.env + cfg.env` 派生子进程环境。结果是
  `github_auth status` 报告 `none`，而 gh 实际已认证。三处调用改为传入合并环境。
- **README/index.js 声称「无客户端半部分」。** 实际有 26,713 字节的 `client.js`
  和 `package.json` 的 `dsh.client` 块。文档已改为描述真实的浏览器半部分。
- **`auth.js` 声称 token「永不返回」**，而 `token` 动作专门返回它。
  声明加上了例外。
- **`release --latest=false` 被注释成「做不到」。** `gh release create --help`
  明确记录 `--latest=false`，且带示例。这个凭空发明的限制让用户无法把
  某 release 从 latest 撤下。
- **`release delete --cleanup-tag`**：help 一直说「optionally its tag」，
  但没有任何参数能请求它。
- **`maxOutputBytes` 是每通道上限**，实际内存可达两倍，且 `truncated` 不置位。
  改为两通道共享一个预算。
- **`github_api` 的 401 提示只匹配 stderr**，而 `Bad credentials` 在 stdout，
  那两个分支永远不生效。
- **`tokenizeQuery` 不校验引号配对**，奇数个 `"` 静默产出半开引号 term，
  gh 以无法定位的语法错误回应。现在返回 `{ error }` 并说明原因。
- **`search sort` 描述举例 `created`**，在 repos/commits 上都非法，
  模型照抄即报 usage error。改为列出三种动作各自的合法值。
- **`actions status` enum 缺 `startup_failure`**（gh 有 14 个合法值）。
- **`pr create` 的 `--fill` 与 `--body` 可同时成立**，而 gh 的优先级未定义。

### P3

- **`resolveRefArgs` 现在对字面 ref 施加 `safeBranchName`**（此前只有
  `repo branches` 用），并说明为何不构成注入。无效 ref 以 note 说明而不是静默改名。
- **`/branches` 路由的三元表达式两边相同**，条件无意义。
- **`repo.js` 重复声明了 `fork` 参数**（对象字面量重复键，后者覆盖前者）。

### 新增守卫

- **`tools/probe-argv.mjs`**：80 个 argv 形状交给真实 `gh <argv> --help` 解析，
  捕获「凭空发明的 flag 名」。
- **`tools/probe-arity.mjs`**：50 个 subcommand 的 positional 数量对照 gh 自己的
  USAGE 行，捕获「positional 超量」。
- **`tools/prove-probe.mjs`**：**量化这两个探针能抓到什么、抓不到什么**——
  包括一条诚实的记录：`pr review` 缺 verdict flag 这一类只能靠执行发现，
  已改为精确 argv 断言。报告 UNKNOWN 而非 PASS。
- **`test/r3.test.mjs`**：25 条回归，每条对应一个本轮缺陷。`npm test` 与
  `npm run release` 均接入。

### Confirmed by measurement

- 136/136 离线测试通过（原 126，新增 10）。
- `probe-argv` 80/80、`probe-arity` 50/50，全部对 gh 2.102.0 实测。
- `prove-probe`：6 类缺陷可离线捕获，1 类不可——后者以精确 argv 断言钉住。

### 修完之后又审查了一遍：五个我自己引入的缺陷

这一节保留，因为它说明「改完」和「改对」不是一回事。以下五项全部由**事后独立复核**
（对比修复前的安装态做逐字节 diff + 针对性探针）发现，且都发生在我以为已经完成之后。

1. **`search` 的坏查询会抛未捕获异常。** `terms()` 在查询非法时返回 `{ error }`，
   而五个 argv builder 写的是 `...terms(a.query)`——展开一个对象抛
   `TypeError: object is not iterable`。实测 `query: "   "` 和未闭合引号都会崩，
   而 `""` 因为 `needs` 门先拦截才没暴露。改为 `searchArgv()`，让 `{ error }`
   作为 `argv()` 的**整个返回值**交给 registry（那条路径本来就支持拒绝）。

2. **`%2e%2e` 绕过了 `..` 检查。** 第一版只查字面 `..`。实测
   `gh api "/repos/%2e%2e/user"` 成功返回 `/user`——HTTP 层解码后再规范化，
   与明文形态到达同一端点。改为先 `decodeURIComponent` 再分段检查；
   `%252e` 这种双重编码仍是字面量，无害。

3. **输出 cap 混用了字节与字符。** `remaining = cap - stdoutText.length` 里
   `.length` 是 UTF-16 码元数，而 `chunk.length`/`subarray` 是字节。CJK 输出下
   实测突破预算（102 B > 100 B cap），且 `subarray` 会切断多字节字符，
   `toString('utf8')` 于是产出 U+FFFD——一个原文里没有的字符。改为全程字节计数，
   切片回退到字符边界。

4. **`repo archive`/`delete` 被错误地加上 `--repo`。** 第一版修复照抄了 `rename`
   的形态，而这三个动作**互不相同**：`rename` 只有 1 个 positional 且接受 `--repo`，
   `archive`/`delete` 接受 `[<repository>]` positional 但**拒绝** `--repo`。
   `probe-argv` 当场以 `unknown flag: --repo` 打回——**探针抓自己的效果立竿见影**。

5. **`pr.js` 的运算符优先级缺括号**，`(a && b) || c` 写成 `a && b || c`。
   逻辑恰好正确，但读起来像经典 bug。加括号并注明原因。

另有三处措辞与行为不符，一并修正：`resolveRefArgs` 的 note 说 "will refuse it"
而实际只警告；`release asset` 参数对 upload/download 是两种含义（本地路径 vs
远端资产名）却被写成一句；`index.js` 的两个 JSDoc 块因插入顺序错位成了孤儿。


## 1.6.1

### Fixed

- **分支菜单项对屏幕阅读器读作 `"devcurrent"`。**

  菜单项的 `textContent` 是分支名和标记**直接拼接**：

  ```
  {"text":"devcurrent","disabled":true,"current":true}
  ```

  **这是探针读出来的，不是猜的。** 视觉上 `.ghk-menu-item` 的 `gap:6px` 把它们分开，
  渲染没问题——**但读出来是一个不存在的词。**

  修法：**按钮获得完整的 `aria-label`**（`"dev, current branch"` / `"Switch to main, 2 behind"`），
  **装饰性 span 标 `aria-hidden`**，另加 `aria-current`。

  探针同步改为**同时读 `text` 和 `spoken`**——因为它们是两个不同的事实，
  **只读第一个正是让这个缺陷一直隐形的原因**：

  ```js
  text:   row.textContent,              // "devcurrent"
  spoken: row.getAttribute('aria-label') // "dev, current branch"
  ```

## 1.6.0

**两个只有「看见」才能发现的缺陷——而它们是第一次看见时找到的。**

### Added

- **`npm run probe:ui`**（`tools/probe-ui.mjs --cdp http://127.0.0.1:9222`）——
  **通过 CDP 从正在运行的应用里读分支胶囊的真实 DOM。**

  这一整轮我反复说「我没有 DOM 访问」。现在有了，**而它第一次运行就找出两个真缺陷
  和一个被证伪的担心**。

  > **走了一段弯路值得记下**：GUI 在 127.0.0.1:19387 上应答，于是我假设「浏览器 → cookie」。
  > **它不是浏览器，是 `DeepSeek Harness.exe`，一个自己铸造会话的 Electron 应用。**
  > 没有任何浏览器参与，也就没有任何 cookie 可找。
  > **我在问「你现在看到这个界面，是在哪个程序里」之前，先花时间去 Chrome 里找 cookie。**

### Fixed

- **`<style>` 元素在胶囊内部，导致 `textContent` 返回整张样式表。**

  探测问「这个胶囊显示什么」，拿到的是 **2.5 KB 的 CSS**。

  改为与触发按钮**同级**（两条渲染路径都要有——第一版我只加在关闭路径上，
  **一弹开菜单样式就全没了**，是靠并排读两个 `return` 发现的）。

- **没有分支可切时，`title` 仍承诺 "Click to switch branch"。**

  条件是 `sessionId !== '' && phase !== 'broken'`，**所以 `idle`（无工作区）时它仍是按钮**——
  标题承诺切换，点开是空菜单。实测：`title` 说 "Click to switch branch"，
  `labelClass` 是 `ghk-pill-idle`，弹出层 `rows: []`。

  改为只在该状态确实有内容时提供：`branch` **和** `detached`
  （分离头指针下，本地分支列表正是想要的）。

### Confirmed by measurement

- **弹出层的 `position: fixed` 没有被祖先裁剪。** 实测 `fullyInViewport: true`，
  矩形 `349×138`。**我当初凭推理担心这件事，现在它是测出来的。**
- 胶囊是 `BUTTON`、`cursor: pointer`、`display: flex`、在视口内（`639,53 45×24`）。

## 1.5.0

**`github_api` 的 7 个参数现在真的被断言了——而做这件事的过程中抓出了第八次同型缺陷。**

### Added

- **`verify-params` 新增 13 条对 `github_api` 的断言**（184 → **197**，覆盖工具 7 → **8**）。

  它是唯一一个**把参数声明在域上而不是动作上**的域，所以「扰动一个声明参数看它是否到达 argv」
  那套方法够不到它。做法改为：**用一个记录型 runner 驱动它的 `custom` 执行器**，问同一个问题——
  **改这个参数，命令行会不会跟着变？**

  | 参数 | 断言 |
  |---|---|
  | `path` | 成为 argv 元素 |
  | `method` | 设置 `--method`，且大写 |
  | `query` | **追加到端点**，不作为独立参数（那会被 `gh` 读成第二个端点） |
  | `body` | **走 stdin**，且**字符串绝不出现在 argv 里** |
  | `paginate` | 加 flag **且**把超时切成 `watchTimeoutMs`（一个参数两个效果） |
  | `confirm` | **是闸门不是参数**：写方法没有它，runner 一次都不被调用 |
  | `timeoutMs` | 到达 runner options；缺失时用配置默认 |

  另加**路径守卫**两条（绝对 URL、反斜杠）——它们此前只写在描述里。

- **`python_api` 的域级参数不再是「可见的未断言」。** 覆盖率行现在报
  `197 parameters asserted across 8 tool(s), 0 NOT covered`，**「not asserted at all」那一节消失了——因为没有未断言的了。**

### Fixed

- **`verify-params` 的 `failed` 是一个过早拍的快照**（L295），而汇总（L498）在它之后读 `results`。

  **后果**：任何追加在第 295 行之后的检查，**失败会被计入总数却从不报告**——
  `results.length` 会涨，`failed` 不会。

  **我是靠一条金丝雀发现的**：往新块里放 `check(false, 'DELIBERATE-CANARY', …)`，
  总数从 197 变 198，**而它没有失败**。

  > **同一个母因的第八次**：从一个过早拍的快照里读数字。

  修法：`failed` 移到汇总前**重算**。修好后金丝雀立刻响，**而真正的双向验证也才第一次生效**——
  拆掉 `--paginate`：

  ```
  === 196/197 passed ===
  - github_api: `paginate` adds --paginate: ["api","/repos/o/n","--method","GET","--BROKEN"]
  exit: 1
  ```

  **在此之前，我加的那 13 条断言的失败全部会被静默吞掉。**

## 1.4.2

**审计报的最后四条，全部处理完。**

### Fixed

- **P3-11 诊断的技能名现在来自 provider 的 `list()`，不是硬编码常量切一刀。**

  `guidance.js` 原写 `PROVIDER_SKILL_NAMES.slice(0, count)`——**报的是这个文件「期望」的名字，
  按 provider 找到的数量切**。两者今天一致，**而一个目录改名、新增或被跳过时就会不一致，
  且不一致是隐形的**——数量和列表仍然互相自洽。

  `registerSkillProvider` 现在**返回名字数组而不是数量**。

- **P2-5 `measure.mjs` 和 `tool-usage.mjs` 现在有失败通道。**

  审计指出这两个文件**没有任何 `process.exitCode` / `throw` / `console.error`**——
  **而 `measure` 是 `check-report` 信任的唯一事实来源。**

  **区分是重点**：
  - **`measure`**：某个区域**零文件**（走查什么都没读到）、`KNOWLEDGE.md` 或 `CHANGELOG.md` 缺失 → **失败**。
    `pluginManagerOperations` 是机器状态，可以合法未知 → **报告，不失败**。
  - **`tool-usage`**：**「记录里没有调用」是关于插件的发现；「记录读不出来」是度量的失败。
    两者不能长得一样。**

  双向验证：把 sessions 根指向空目录 → `FAIL … nothing was measured`，exit 1；还原 → exit 0。

- **P3-10 `index.js` 的销毁日志现在守卫 `ctx.effect`。**

  真实 Cordis 上下文里它一定存在，所以今天不会触发——但 `lib/deferred.js` 在
  `installWhenAvailable` 第三行就检查它，**而一条销毁日志不该因为机制缺失把插件带走**。

### Not a defect

- **P3-9 「`/branch` 方法检查先于认证」——实测不成立。**

  四条路由用非预期方法请求，**全部返回 401**：

  ```
  POST /branch      401     POST /branches   401
  POST /diagnostics 401     GET  /switch     401
  ```

  审计看到的是 1.3.0 修之前的状态。

## 1.4.1

### Fixed

- **P2-6 `verify-bundle` 的导入检查测的是「存在」而不是「可解析」。**

  `existsSync` **对目录也返回 true**，所以一个叫 `does-not-exist.js/` 的**目录**能通过，
  而导入在运行时失败。改为要求 **`statSync().isFile()`**，并在失败时说明**发现了什么形状**
  （「有东西但不是文件」和「什么都没有」需要不同的修法）。

  双向验证：造目录 + `from` 导入 → `FAIL … (tools\_probe-dir.js exist but are not files)`。

- **同一个检查漏掉第三种导入形式。** 修正则只匹配 `from '...'` 和 `import('...')`，
  **裸的副作用导入 `import './x.js'` 从未被看过**——用那种形式探测时计数停在 141 才发现。

- **检查在扫描注释和字符串，而不只是代码。**

  修目录那条时我写了一句注释解释三种形式，**注释里引用了 import 语句**——
  正则匹配到它，检查于是报 `-> ./x.js (nothing at that path)`：**它在把散文当代码扫。**

  **这是本项目已经记录过三次的同一缺陷**——扫描参考仓库时把 README 里的一句安全声明
  当成环境变量泄露风险——**而当时写下的措施第 ③ 条就是「扫描代码前剥离注释」。
  那条措施从未被应用到本文件，所以第一次有注释引用代码时就犯了。**

  改为**先剥离整行注释与块注释**再匹配；只在**行首**是注释时才剥离，
  因为字符串里的 `//` 不是注释，在那里截断会漏掉真实导入。

  **连带结果**：`141 个导入` 里有 **49 个从来不是导入**——35% 的计数是虚构的。
  现在报告 **92 个**。

## 1.4.0

### Changed — P2-4 的口径：**门禁判定产物，看板判定过程**

原问题：看板 5/8 族红、打印 `ACTION REQUIRED (5)`、**却 exit 0**，而报告在宣传绿色门禁。

**我给你的第一版框架是错的。** 我问「门禁该因历史失败还是因回归失败」——数据否掉了它：

```
23 个事件全部集中在 2 天（10-15 有 16 个，10-16 有 7 个）
```

**这不是历史积累，是同一个工作会话。** 所以我把两个不同的问题塞进了一个闸门：

| 工具 | 回答的问题 |
|---|---|
| `npm run verify` | **这个产物对不对？** |
| `npm run recurrence` | **我们的工作方式在不在产出缺陷？** |

**一个是产物的属性，一个是过程的度量。**

### Added — 门禁在**回归**上失败，不在**历史**上失败

- **`docs/recurrence-baseline.json`** 记录接受发布时各家族的事件数。
- **任一计数增加，或出现新家族 → `npm run verify` 失败。**
- **`npm run recurrence:accept`** 写新基线——**运行它就是承认动作。**

**摩擦本身就是设计**：记一个新缺陷事件会让门禁变红，**而唯一变绿的路径是运行一条说「我看见了并接受新状态」的命令**。

双向验证：注入一个新事件 → `FAIL FAM-P-01: 4 → 5`，exit 1；还原 → exit 0。

**为什么不做成「红了就失败」**：根因族靠**改变工作方式**闭合，不靠一次提交。让门禁因它失败，门禁会无限期地红下去——**一个不可能变绿的门禁，没人会看**。

**为什么也不保持纯度量**：今天的证据是——**看板红了 5 个族，而我一直到审计结束才去看它**。一个红着的度量，如果没有人被迫面对它，就等于不存在。

### Notes

`verify` 现在会因新增缺陷事件而失败。**这是它第一次能回答「这次改动让事情变差了吗」。**

## 1.3.1

### Fixed

- **P2-7 `verify-params` 报「0 NOT covered」而它的域列表里根本没有 `github_api`。**

  覆盖率是在**一个已经排除了整个工具的集合**上算出来的。独立审计把列表与 `lib/domains/` 对照后发现的。

  排除本身是结构性的：其他域把参数声明在**动作**上，而 `github_api` 声明在**域**上——
  这个工具的整套方法就是「扰动一个声明参数，看它是否到达 argv」，而那些参数不在它走的路上。

  **不可接受的是在排除之后仍报满覆盖。**

  **第一版修法我说错了一次**：写成「它的动作是手写的，没有声明的 `params` 可扰动」。
  去读 `api.js` 才发现**有 7 个**（`path`/`method`/`query`/`body`/`paginate`/`confirm`/`timeoutMs`），
  **它们和被测的那些一样被渲染给模型，只是位置不同。**

  > **数出它们，和一句「形状不同」带过，是「给边界命名」与「为缺口找理由」的区别。**

  现在报告会打印：

  ```
  not asserted at all (1 tool(s), 7 parameter(s)) — OUTSIDE the count above, not inside it:
    - github_api (7 params): it declares 7 parameter(s) on the DOMAIN, while every asserted
      domain declares them per action — the perturb-one-parameter method does not reach them
  ```

### 未验证的部分，如实登记

**「遗漏 vs 形状」的分支我没有验证成功。** 我两次尝试给 `api.js` 注入 `params`，
替换都没落地（实际文本与我的匹配串不符），所以那条分支**从未被执行过**。

**报告里打印的是该分支的当前行为，不是我验证过的行为。**

### Notes

仅工具输出，无运行时行为变化。

## 1.3.0

**这一版是 `npm run audit` 第一次按设计运行的结果**——它产出了六条我不知道的事，
其中三条是「守卫不可能失败」。**同一家族，第四次。**

### Fixed

- **P1-2 四条路由在无 `connection` 服务时全部失败开放，包括会执行 `git switch` 的 `/switch`。**

  审计驱动真请求逐条测过：无 connection 时四条**全部返回 200**。

  **修法不是「一律拒绝」，也不是「环回就没关系」，而是看出四条路由的后果不同：**

  | 路由 | 做什么 | 无门禁时 |
  |---|---|---|
  | `branch` `branches` `diagnostics` | 读工作区路径与分支名 | 泄露给本机任何进程 |
  | **`switch`** | **改用户的工作树** | **本机任何进程都能切你的分支** |

  > **规则：服务的缺失不是同意。** 一个判断不了请求的装置，不能把「判断不了」
  > 当作「判断安全」——尤其当这个请求会改动别人的东西。

  **代价也是不对称的**，这才是这个切分正确的理由而不是妥协：
  拒绝读路由会让胶囊彻底失效，拒绝 `/switch` 只是不能切、分支照常显示。

  **刻意不做开关**：一个没人会设对的旋钮只是多一个出错的地方。

  新增断言（`test/offline.test.mjs`）：无 connection 时读路由 200、`/switch` **403**、
  有门禁时不被误拒。**测试 101 → 102。**

- **P1-3 `verify-bundle` 的兼容性检查在缺输入时静默 PASS。**

  `check(true, …, 'skipped')`——**一个以「抓 peer 范围不匹配」为全部目的的守卫，
  没看就报绿。** 审计改掉硬编码路径就复现了。

  改为**第三种状态 `UNVERIFIED`**：不是 PASS（没看不能报绿），也不是 FAIL
  （路径是本机特有的，别处永远失败会训练人忽略它）。**汇总行每次都会打印未验证数**——
  **沉默与成功不能长得一样。**

  双向验证：路径改坏 → `UNVERIFIED`；还原 → 全部通过。

- **P3-8 `probe-connectivity` 用同一条断言冒充两条**（216/217 行都是 `found === 9`，
  `28/28` 实际是 27 项）。换成升序 refs（3,7,9）：**首匹配实现返回 3，`Math.max` 返回 9**。
  反向验证：把实现改成取第一个匹配 → 断言以预测的消息失败。**旧版本会漏掉这个回归。**

- **`npm run audit` 的简报是「有任务、没手段」**——6 项必要事实缺 5 项
  （仓库路径、profile、已装副本、asar、脚本清单）。新增 `## Where everything is`，
  路径从环境读出。**3476 → 4502 字符。**

### Notes

路由行为与守卫语义有变化，**需要重启**。

## 1.2.0

**三个长期标记为【待验证】的问题，这一版全部给了答案。** 它们此前不是「没做」，
是**需要的数据在别处**——操作日志与会话记录。找到了就能答。

### Added

- **`npm run operations`** —— H-02 与 H-03 的答案（`tools/classify-operations.mjs`）。

  | | 报告估计 | **实测** |
  |---|---|---|
  | 本包操作数 | 56 | **91**（另有 9 次属别的 bundle） |
  | 返工 | ~20 | **11** |
  | 版本数 | — | 35 |
  | 换装耗时 | 4–8 分钟（含重启） | **宿主侧 44 对：最快 2.1s / 中位 3.1s / 最慢 16.3s** |

  **报告「56 次中约 20 次返工」在两个方向上都错了**：操作更多、返工更少。

  分类规则**写在工具里而不只是结论里**，因为**未声明的规则就是穿着数字外衣的结论**：
  只把「迭代不可能产生的情况」计为返工（重装一个已装过的版本）。
  **它不把「我不需要的发布」计为返工**——判断那件事需要意图，而意图不在日志里。

- **`npm run usage`** —— H-05 的答案（`tools/tool-usage.mjs`）。

  解压 12 个会话记录（**19270 条**）：**40 次 `github_*` 真实调用，59 个声明动作里 46 个从未被调用**。

  **会话记录不是单个 zstd 流，是几百个独立帧追加的**——审计那个会话有 **413 帧**。
  `zstdDecompressSync` 只解第一帧就停，**所以一个 758 KB 的文件解出 260 字节，看起来是空的**。
  按魔数 `28 B5 2F FD` 切开逐帧解压后：660 条记录、136 次工具调用。

  ⚠️ 输出里注明了局限：**样本混着探针自己的测试调用**（如 `github_repo not-a-real-action×3`），
  所以「未被使用」是「在这些记录里没被调用」。

### Fixed

- **`classify-operations` 的换装统计从未打印**：`swaps` 是**数组**，而打印条件写的是
  `swaps.count`——数组没有 `.count`，`undefined > 0` 恒为假。**44 对换装一直被检测到、
  然后从未被显示。** 这正是本项目反复出现的形态：**计算对了，报告错了。**

- **`tool-usage` 曾把 `data.arguments` 当成对象**，而它是 **JSON 字符串**——
  于是每个动作都报成 `(no action)`，**输出在唯一要紧的地方失效了：它说 59 个动作全部从未被调用。**

## 1.1.0

**这一版来自「报告里该做的都做完了吗」这个问题。** 核实后答案是没有，清单如下，全部做完。

### Added

- **A-09 `npm run audit`** —— R2 独立审计固化为流程（`tools/audit-brief.mjs` + WORKFLOW §11）。

  项目此前一直把 `npm run verify` 退出 0 当作收敛，**而那是 R1 单次检查**。
  **唯一一次派独立审计者的结果是 P-25——113 项守卫全绿，运行中的组合却服务着上一代技能。**

  它**不运行审计**，只打印交给审计者的简报——**因为「上下文不共享」无法自动化掉**：
  同一会话里派出的审计者会继承同一批假设，而假设正是要被检验的东西。

  三条承重规则，每条来自一次失败：**默认推翻** / **报 0 findings 不构成证据** /
  **finding 是输入不是结论（调用方必须逐条独立复核）**。

- **A-10 门禁分层** `verify:offline` / `verify` / **`release`**。

  独立审计指出 **`verify` 不包含 `encoding`、`report:check`、`profile:check`，
  而文档和 CHANGELOG 一直称它是「交付门禁」**。已更正口径并分层：
  **一个干净 checkout 上跑不通的检查，不该让源码门禁失败**——那会训练人忽略它。

- **A-11 `tools/compare-installed.mjs`**（`npm run compare:installed`）——
  **已装副本与源码逐字节比对**。

  补的是 0.9.5/0.9.6 那次不同步：**项目里没有任何检查能发现**，是审计者手工比对
  两处 `package.json` 才看到的。它同时声明能力边界——
  **它比对文件，无法报告运行中的进程是否加载了它们**（那正是 P-25 的形态）。

- **U-05「可编程重载」查证完毕：不存在。**
  官方契约原文：*"Installing a new bundle can activate through HMR; **replacing an installed
  package requires restart** to load a fresh JavaScript module generation."*
  **重启是结构性的，不是流程缺口**——该项从「待确认（最高价值）」转为「已排除」。

### Fixed

- **`record-prevention` 现在真的执行它头部写的标准。**

  它写着「『我们加了守卫』不是胜绩」，**而第一版接受那句话**——一个记录着它不执行的标准的可执行文件。
  现在拒绝：描述措施而非观察的措辞、未来日期、`--date` 无值、格式错误的日期。
  **双向验证**：五种非法输入全部被拒，真实胜绩仍可录入。

- **同一个校验器抓到自己的时区 bug。** 它用 `toISOString()`（UTC）比本地日期，
  在东八区的 00:00–08:00 之间，**任何合法的本地日期都会被判成「未来」**。
  **我为抓坏输入而写的守卫，抓到了我自己的 bug。**

- **`rejectUntrusted` 的失败开放不再无声。** 无 `connection` 服务时它照常放行——
  这是刻意的（拒绝会破坏没有该服务的组合），**但现在会说一次**：
  **一个缺席的门禁和一个放行的门禁，从外面看是一样的，只有日志能分开。**

- **`/branches` 与 `/switch` 的方法检查移到认证之后。**
  原顺序让未认证的 GET 得到 405，**等于告诉调用方这条路由存在**。

- **诊断路由的 `routes` 字段**（1.0.0 时被测试抓到）与**报告附 A 的 A-04 误标**已更正：
  附 A 把 A-04 写成「换装一致性校验」并标完成，
  **而 §7 的 A-04 是「换装脚本（合并卸载/安装＋前后校验）」——同一编号在两处指两件事。**

### Notes

路由顺序与校验器行为有变化，**建议重启**（`npm run release` 会报告已装状态）。

## 1.0.3

### Added

- **报告的 §3 与 §10 增加「当时判断 → 实测」对照节**，覆盖 0.4.0 → 1.0.2。

  只补正文不重写（重写会让当时的判断无法评估）。**两处对照里有三条结论值得单列：**

  1. **S-03「声明式守卫编写」被降级，而它是此后失效最多的技能。**
     当时的筛选规则是「权重 ≥20% 且熟练度 ≤3」，S-03 权重 20%、**熟练度自评 4**——差一分没命中。
     此后守卫**又失效四次**（P-17 / P-24 / check-encoding / P-25），一次比一次隐蔽。

     > **自评熟练度不能作为「不需要盯」的依据**——它没有外部校准，而权重是有的。

  2. **S-06「外部证据核验」在写下「关键待优化」和三条优化措施之后，又犯了同样的三次。**
     扫描 5 个参考仓库时报「安装钩子 ×2 + 风险命中 ×8」，**逐个查证后全部是误报**。
     而 §3.3 给它写的措施第 ③ 条正是「**扫描代码前剥离注释**」——
     我的扫描器把 README 里的安全声明当成了风险。

     > **优化措施写对了，但没写进守卫，也没在下次执行前被读到。**
     > **报告得分最高的经验 E-01（4.75）「约束必须转成守卫，否则视为未掌握」在报告自己身上失效了。**

  3. **§10 的 10 项自评里 7 项达成、2 项部分/未做、1 项未验证。**
     唯一「自评对但一直没做」的是 A-04（Windows 文件锁重试）——
     它此后又失败两次，**差别不在运气，在流程**：附 P 之后写了「旧产物保留到校验通过」，
     1.0.2 那次照做，同样的 EPERM 就没变成事故。

### Notes

仅工具与文档，**无运行时行为变化**。

## 1.0.2

### Fixed

- **复盘报告的正文在执行摘要处与实测脱节**，而这件事本身就是报告的核心发现。

  执行摘要写的是 **0.4.0 时点**的「4268 行 / 19 模块，10 个版本，56 次操作，18 个缺陷」，
  而实测是 **6074 行 / 23 文件、28 个版本、94 次操作、25 个缺陷**。

  **这份报告的核心发现是 FAM-P-06「文档与实现漂移」（4 个事件、复发 3 次）——
  而它自己的正文正在漂移。** 只读执行摘要的人拿到的是 0.4.0 的画面。

  修法不是改写正文（那会让当时的判断无法评估），而是：
  1. **目录与执行摘要开头加「读法」**——正文写于 0.4.0，附录写到 1.0.1，**不一致处以附录为准**
  2. **执行摘要加对照表**：首次成稿 vs 现在，逐项列出
  3. **加「五项改进的达成情况」表**——那是报告最该被检验的部分：
   ✅ 两项达成、⚠️ 两项部分、❌ 一项未达成（安装原子化，附 P 与 1.0.1 的 EPERM 各一次）

- **报告结构错乱**：`附 W` 出现两次（占位 + 正文）、`执行附录四` 标题下面是空的、
  目录里没有附录四。已修正。

- **`check-report` 此前只守卫附录的对照表，不守卫执行摘要。**

  它第一次只比对附 N 的数字，所以摘要可以一直写着 0.4.0 而守卫通过。
  **摘要是读者最先读的部分——守错了文档。**

  现在 `versions` 一处两个 marker，附录表和摘要表都要匹配。
  双向验证：把摘要的版本数字改回 23 → 守卫报 `STALE versions`。

  > 写这段时**四个数字当场就过期了**——我改摘要的同时还在加文件和发版。
  > 这就是「为什么需要守卫」的现场演示。

### Notes

仅文档与工具，**无运行时行为变化**。

## 1.0.1

### Verified

**分支胶囊的切换功能由用户在运行中的 GUI 里确认可用。**

这闭合了独立审计列出的**最大未测面**——它和我都没有 DOM 访问，所以「胶囊是否真的渲染」
一直是唯一没有直接证据的部分。现在：**胶囊渲染正常，点击可展开，切换生效。**

至此本插件的**四条路由、三个技能、九个工具全部有运行中的直接证据**，不再是推断。

### Recorded

- **FAM-P-06 的第一条预防胜绩**（该族此前 0/4，一直红）。

  把路由从 2 条加到 4 条时，离线套件**当场在三个计数断言上失败**，其中一个暴露了
  **真的源码 bug**：诊断路由仍报 `routes: [BRANCH_ROUTE, DIAGNOSTICS_ROUTE]`。

  **守卫在 CI 里抓到了「实现与它对外发布的内容漂移」，在发布之前。**
  这正是预防措施应该有的样子——**不是「加了守卫」，是「守卫抓到了具体的东西」**。

### Notes

仅数据与文档，**无运行时行为变化**。

## 1.0.0

### Added

- **分支胶囊可以切换分支了。** 此前它只是只读指示器——显示分支名与 PR 状态，切换能力只给了
  模型（工具），没给 UI。用户指出后补上。

  **两条新路由**（`/dsh-github-toolkit/branches`、`/dsh-github-toolkit/switch`）：

  | 路由 | 方法 | 用途 |
  |---|---|---|
  | `branches` | GET | 本地分支列表 + ahead/behind + 工作树是否干净 |
  | `switch` | **POST** | 执行切换 |

  **为什么 switch 必须是 POST**：GET 会被链接、图片标签、预取触发。要求 POST 意味着页面
  「必须是故意的」。这是本插件第一条会**改动用户工作树**的路由。

- **注入防护靠成员校验，不靠转义消毒。**

  `git switch <name>` 会把开头的 `-` 当**选项**，所以 `--force` / `-f` 不是分支名而是参数——
  而它们会**丢弃未提交的工作**。

  消毒（去横线、加引号）是常见答案，但在这里是错的：它引入「哪些形状危险」的规则，
  而**这类规则会错一次**。改为：**分支名必须是我刚从 `git for-each-ref` 读到的真实 ref**，
  否则在 git 看到它之前就拒绝。**没有字符串能通过这个检查却仍是选项——因为选项不是 ref。**

- **`--force` / `--discard-changes` / `-C` / detached 一律不实现。** 脏树**拒绝并说明原因**，
  不强行推进。`git switch` 本来也会拒绝，而**报告原因比一个通用失败有用**。

- **两条新路由只接受 `sessionId`，不接受路径。** 我第一版写了接受 `path`——
  **那违反了只读路由自己写明的原则**（「never by a path, so this component cannot point the
  Host at a directory of its own choosing」）。已改：页面只能命名会话，不能命名目录。

- **`tools/probe-branch-switch.mjs`**（`npm run probe:branch`）——**27 项，其中 15 项是注入尝试**：
  `--force`、`-f`、`--discard-changes`、`-C`、`--detach`、`HEAD~1`、`refs/heads/main`、
  换行藏参、`$(whoami)`、`; rm -rf /`、反引号替换、路径穿越。

  它需要**真实仓库**（默认找 `D:/xiyouji`），因为**自建 fixture 是在测试 fixture 而不是 git**。
  它**保证把仓库留在原分支**，并且我事后独立确认过（`dev`、工作树干净、两个分支都在）。

### Fixed

- **诊断路由的 `routes` 字段硬编码了两条路由**，新增后仍报两条。**是测试抓到的**——
  我把路由从 2 条加到 4 条时，`routes` 字段没有跟着变。

- `readJsonBody` 有 64 KB 上限：这是唯一读请求体的路由，**在环回路由上做无界读取，
  等于让调用方决定 Host 分配多少**。

### Notes

**客户端半身有改动，需要重启 DSH 才会生效。**

新的弹层用 `position: fixed` 并从触发按钮的矩形定位——因为胶囊所在的头部行的祖先可能裁剪
溢出，**而一个开进裁剪框里的菜单是看不见的，且原因在代码里观察不到**。

**我仍然无法验证渲染**（没有 DOM 访问）。宿主侧 27/27 有实证；**弹层的视觉需要你确认。**

## 0.9.8

### Verified

**重启后确认：0.9.0 的技能重构与写入边界现在真的生效了。**

这是此前从缺的一步——验证**运行中的组合**，而不只是文件。调用 `skill github-ci-triage`
与 `skill github-pr-review` 的结果：

| 项 | 重启前 | 重启后 |
|---|---|---|
| 资源行 | `managed by provider "runtime"` | `Base directory for this skill: …\dsh-github-toolkit\skills\<name>` |
| `## Write boundary` | 无 | **有** |
| Workflow 步骤 | 5 | **6** |

`resourceBase` 是**只有 `PackSkillProvider` 才会带的字段**——运行时注册永远不会设置它。
**这是新 provider 赢得目录的直接证据，不是推断。**

### Recorded

- **P-25 → FAM-P-03**（第 4 个事件，复发率 75%）：`probe-guidance` 113/113 全绿、
  `verify` 退出 0 的同时，**运行中的组合服务的是上一代技能正文**。
  旧的 rank-250 运行时注册压过 rank-600 的打包 provider。

  **根因值得单独记**：`probe-guidance` 用假的 `skills` 服务测 `PackSkillProvider` 本体，
  **从不查真实注册表**。**一个在隔离环境里测试组件的守卫，无法报告组合的状态。**
  守卫是绿的，组合是旧的，两者同时成立。

## 0.9.7

**这一版来自一次独立审计**（不共享主代理上下文，默认推翻十条断言）。审计有实证、有实验、
有工具调用证据，**其中最重的一条我自己复查后成立，而且它是关于我此前对你说过的话**。

### Fixed

- **`check-encoding` 漏掉两个已发布文件**，而摘要读起来像「全都查了」。

  `TEXT_EXT` 里没有 `.svg`，`LICENSE` 没有扩展名——**两个都被静默跳过**，
  工具仍打印 `checked 60 text file(s) / clean`。审计注入 BOM 实验证明：
  改 `README.md` 会被抓，改这两个不会。现为 **62 个文件**。

  **这正是本项目自己写的 PRE-17「守卫必须声明它不覆盖什么」，被它自己违反**——
  我修了「包外」盲区，没修「扩展名」盲区。除放宽集合外，现在还会**打印跳过了什么**，
  让下一次遗漏是可见的而不是隐含的。

- **`verify-bundle` 第 7b 项只比较顶层名字**，`docs/` 下新增文件不可见。

  `manifest.files` 逐个列举 `docs/*.md`，所以新加一个 `docs/*.md` 不会被打包，
  而 7b 报 PASS。审计用 `docs/AUDIT-UNSHIPPED.md` + `npm pack --dry-run` 证明。
  现在会走查每个「被逐文件列举」的目录。**该实验复现后现在会失败。**

- **诊断路由的 guidance 字段在说假话。** 它自称「Whether the guidance reached the model」，
  值是 `PROVIDER_SKILL_NAMES.slice(0, count)`——**本 provider 自己 `list()` 的结果**，
  不是目录里真正胜出的技能。**与 P-24 同类：把输入当输出报。**

  字段更名为 `offeredByThisProvider` 并携带 `offeredIsNotCatalogState` 与说明。
  **正确修法需要解析真实目录，本路由做不到，所以它现在说明自己测的是什么。**

- **已发布文档与代码相反。**
  - `cordis.patch.yml`：「no Config schema is declared on purpose」——**而代码有**
  - `docs/DESIGN.md`：「不声明 `Config`」「刻意零依赖」「不声明任何 `peerDependencies`」——**三条全部被代码推翻**

  均为加入 schema 之前的旧设计。**FAM-P-06（文档与实现漂移）的两个新实例**，已更正并留痕。

### ⚠️ 需要重启

**此前我说 0.9.x「不需要重启」——对技能那一项是错的。**

运行中的进程（启动于 00:43）服务的是**旧技能**：`provider "runtime"`、无 `whenToUse`、
**无 `## Write boundary`**、5 步而非 6 步。`RUNTIME_RANK = 250` 压过 `PACK_RANK = 600`，
**旧运行时注册遮蔽了新 provider，而所有守卫都是绿的**。

**这是 FAM-P-03 的第六次发作**：我的守卫全部只测 `PackSkillProvider` 本体，没有一个查真实目录。

## 0.9.6

### Added

- **`probe-guidance` 新增引用完整性校验**：`skills/*/SKILL.md` 里点名的每个工具与动作
  **必须真实存在**（66 项 → **113 项**）。

  此前的检查是 `/github_[a-z_]+/`——**它只证明「有一个形状正确的名字出现」**。
  写 `github_nonexistent` 会通过；把 `checks` 改名而技能不改，也会通过。
  后者才是真正要紧的失效：**技能会自信地叫模型去调一个不存在的东西。**

  注册表**从 `lib/domains/*.js` 读出**，不在守卫里重述。重述的清单会与实际构建的清单分叉，
  **而分叉在被发现之前不可见**——这正是本条要防的。

  三种引用形态、一个解析器：显式（`` `github_pr` action `view` ``）、多名
  （`` action `merge`, `close` ``）、**裸的**（`` action `status` ``，归到同段落内最近的上文工具）。
  裸的那一种是不能用一个正则解决的原因；**归属不明时报告为「未归属」而不是猜**——
  猜会产生假警报，而**会喊狼来了的守卫会被关掉**。

  双向验证：不存在工具 / 不存在动作 / 改名未同步，**三种违规分别失败**。

- `docs/KNOWLEDGE.md` 新增 **K-16 引用完整性扫描（改动影响面）**（16 条记录，53 项断言）。

  K-16 与 P-24 记为**同一母因的两个方向**：

  | | 方向 | 表现 |
  |---|---|---|
  | P-24 | 守卫 → 被守卫对象 | 守卫读内存副本，原件变了它不知道 |
  | K-16 | 被守卫对象 → 引用它的文本 | 原件变了，引用文本不知道 |

  **两者都是「对象之间缺少连接」。**

### Notes

仅工具与文档，**无运行时行为变化，不需要重启**。

## 0.9.5

### Added

- **复发看板新增「预防成功」列** + `tools/record-prevention.mjs`（`npm run prevention`）。

  起因：读了另一个项目的**方法论沉淀层**（`D:\xiyouji\docs\10-方法论沉淀\`），它的总览表这样记：
  `E1 跨 session git tracked | 23/23（含 W085/W086 预防成功 0 文件）`——
  **分子同时数「发生」和「防住」，而本项目的看板只能数失败。**

  后果是一个**无法区分的两种绿**：一个有预防措施且没再出事的族，与一个措施从未被检验过的族，
  **显示完全相同**。前者是「已被保护」，后者是「措施落地后尚未被观察」。

  现在看板会打印：`6/8 families have no recorded prevention success. Green there means
  UNOBSERVED since the measure landed, not PROVEN protected.`

  `record-prevention` 拒绝「加了守卫」这类记录——**「没出事」是默认状态，不是证据**。
  胜绩必须是具体的：守卫拒绝了什么输入、在哪一刻规则被遵守了。

  首批录入两条真实胜绩（本轮实测发生）：
  | 族 | 胜绩 |
  |---|---|
  | FAM-P-05 | `check-profile` 在 `remove_bundle` EPERM 失败后立刻抓出半坏 profile |
  | FAM-P-03 | `probe-guidance` 拒绝了三个注入违规（目录/frontmatter 不符、缺写入边界、缺描述） |

- `verify-bundle` 新增**反向检查**：不仅「白名单里的文件存在」，也检查
  **「存在的文件在白名单里」**。

  这是铁律 E1 的同形缺陷：**东西存在 ≠ 东西会发布**。
  0.9.0 写的 `skills/` **会整个从 tarball 里消失**，因为把目录加进树不会把它加进 `files`——
  那次是靠想发现的，不是靠守卫。

### Notes

仅工具与文档，**无运行时行为变化，不需要重启**。

## 0.9.4

### Changed

- `tools/check-report.mjs` 改为**默认只报告漂移（退出 0），`--strict` 才失败**。

  原因：它第一次运行就暴露了自己的设计缺陷——**任何对 `tools/` 下文件的编辑都会改变
  工具行数，而那是它核对的九个数字之一**，于是「修好它」这个动作本身会让它再次失败。

  **一个每次改动都会失败的门禁，没人会看。** 这与复发看板（`npm run recurrence` 默认退出 0、
  `--strict` 用于评审）是同一个决定、同一个理由。漂移被**打印出来**，那才是维护信号。

  工具头部写明了它的**能力边界**：它无法把某个数字与「该数字声称描述的那个版本」核对，
  因为历史测量不可复现——它只能发现**快照落后于现状**。**一个在写下时就错的数字会通过检查。**

### Notes

仅工具与文档，**无运行时行为变化，不需要重启**。

## 0.9.3

### Added

- `tools/check-report.mjs`（`npm run report:check`）—— 把复盘报告里的数字与 `tools/measure.mjs`
  的实测值**逐项交叉核对**。报告以固定、可 grep 的形式陈述每个数字，脚本比对，**不一致即失败**。

  起因：用户问「报告里的内容增加了吗」。手工核对一次就抓到 **3 处不一致**——
  版本数落后一个、文档行数少 165、事件总数少一个。
  **它们写下来时都是真的，然后一直被读**——这是「数字」这种产物的失效方式：
  没人会重新测量一个自己已经相信的数字。

  **它第一次运行就抓到了新的失效**：加入这个检查工具本身让 `tools/` 的行数与文件数变了，
  而报告里的对应数字随之过期。**检查器让自己要检查的数字过期了。**

### Notes

仅工具与文档，**无运行时行为变化，不需要重启**。

## 0.9.2

### Added

- `tools/check-encoding.mjs`（`npm run encoding`）—— 检查每个文本文件的 BOM、NUL 字节、
  UTF-8 有效性、混用行尾。**默认只覆盖包内文件**，包外文档需显式传路径（工具头部写明了这个盲区）。

  它来自一次外部复盘的断言，逐条实测的结果：

  | 断言 | 实测 | 结论 |
  |---|---|---|
  | `>` 重定向写 UTF-16LE | 前 4 字节 `255,254,112,0` | **成立** |
  | `Set-Content` 写 UTF-8 BOM | 无 BOM | 本机不成立 |
  | `Add-Content` 中文写 GBK | 4 汉字 = 12 字节（UTF-8） | 本机不成立 |

  后两条不成立的原因：**系统 ANSI 代码页是 65001（UTF-8）**。
  所以现有文件干净是**系统设置带来的，不是工具保证**——这是这一版最该记住的一点。

- `docs/WORKFLOW.md` §0 补充三节：
  **什么情况下 PowerShell 反而是对的**（注册表/服务/证书/COM/时间戳）、
  **「换 Git Bash」在本项目的核实结论**、**编码实测与潜在风险**。

### Notes

仅工具与文档，**无运行时行为变化，不需要重启**。

## 0.9.1

### Added

- `tools/measure.mjs` —— 项目度量的**唯一口径**，`npm run measure`。
  它存在的直接原因：此前所有行数都是用 shell 管道算的，而 `Measure-Object -Line`
  **不计空行**，导致数字系统性偏低（产品代码少 301 行、文档少 516 行）。
  报告同时给出「含空行」与「非空行」两个数字，并说明差异来自口径而非漂移。

- `docs/WORKFLOW.md` §0 工具分层规约：**任何会被报出的数字，必须来自 `tools/` 里的脚本**。
  记载了实测的九类 shell 层失误（四类会报错、**一类给出自信的错误答案**），
  以及判据——一条命令里同时出现管道、字符串处理和数字，它就该是一个脚本。

### Notes

仅工具与文档，**无运行时行为变化，不需要重启**。

## 0.9.0

指导层按生态惯例重构，并补上每个工作流各自的写入边界。这一版来自**对参考仓库真实代码的阅读**，
不是 README。

### Changed

- **技能体从 `lib/guidance.js` 里的内联数组移到 `skills/<name>/SKILL.md` 文件**，
  改由 `lib/skill-provider.js` 的 **provider** 提供。

  为什么是 provider 而不是三次 `register()`：

  1. **指令是文件，不是 JavaScript。** 审阅者可以直接读和 diff `skills/github-ci-triage/SKILL.md`，
     改措辞不需要改「在加载时拼字符串」的代码。
  2. **`resourceBase` 让相对路径可解析。** 技能目录可以把 `scripts/` 放在 `SKILL.md` 旁边，
     正文可以引用它——这是生态里技能包携带可执行帮助的方式。我们这三个技能暂时不需要脚本
     （它们驱动本插件自己的工具），但**形状决定了将来能不能加**。

  契约与 `@deepseek-ai/dsh-skill-filesystem` 及社区技能包一致：`list` 返回带 `locator` 与
  `resourceBase` 的候选，`get` 接收该候选并返回正文。**技能体在每次 `get()` 时从磁盘重读**，
  所以改 SKILL.md 不需要重新激活插件。

- **`rank: 600`** —— `rank` 是 provider 概念（运行时 `register()` 没有）。
  打包技能排名**低于** project/user/custom 根（100–500），**用户自己写的同名技能胜出**。

- **目录名、frontmatter 名、目录项名必须一致**。三者不一致时 provider 拒绝该技能并告警——
  否则目录会提供一个名字、文件在别处，而没有任何东西会报告。
  缺 `description` 的技能被整体排除：目录页展示的是描述而不是正文，没有描述就无法被正确发现。

- **`skills` 加入 `package.json` 的 `files`**，否则技能随包丢失。

### Added

- **每个技能新增「Write boundary」小节**（代码分析后的补充）。共享的提示词 section 有全局规则 4
  「破坏性动作会询问用户」，但**批准一个 PR、重跑一个 workflow、推送一个修复，不是同一种许可**。
  三个技能各自写明：读始终自由；评论/审查以用户账号发言，需明确要求；`rerun` 会丢弃上次结果；
  `issue close` 不应手工做（`Closes #N` 会在合并时关闭）。

- `tools/probe-guidance.mjs` 重写为**读真实文件**（66 项，原 45 项）。它现在校验：
  声明列表与磁盘目录一致、**没有技能被静默跳过**、kebab-case、描述长度、`whenToUse` 存在、
  `rank` 与 `source`、`resourceBase` 形状、正文经 `get()` 真实加载、工作流/停止条件/写入边界齐备、
  以及 frontmatter 名与目录名一致。

  **它此前校验的是 `guidance.js` 里的内存数组**——那是指令的副本，不是指令本身，
  两者可以不一致而无人发现。

### Not changed

核实后无需行动：`--dsw-*` 主题 token 在官方注册表里**只有 14 个**，正是本插件使用的那些。
某个参考项目用到的 `--ds-font-family-code` 等 token 不在注册表内。

## 0.8.3

### Changed

- `docs/recurrence.json` 录入 P-23（换装事故）。问题族 **FAM-P-05 转红**：
  它与 P-16 母因相同——构建/分发操作没有考虑「还有什么依赖着我即将移除的东西」。
  当前 **8 族中 5 族为红**。
- `docs/WORKFLOW.md` §4 换装顺序修正为：**打包 → remove → install → 校验 → 才允许删除旧产物**。
  记录了工具链的不可恢复状态：依赖指向缺失文件时 `install_bundle` 返回 `ambiguous-install`
  并拒绝处理，恢复路径只有手工编辑 manifest。
- 复盘报告新增附 P，记录该事故的完整经过。

仅数据与文档变更，**无运行时行为变化，不需要重启**。

## 0.8.2

### Changed

- `docs/recurrence.json` 录入本轮新增的四个缺陷（P-19…P-22），问题族由 6 增至 **8**：
  新增 FAM-P-07「位置假设被结构变化打破」与 FAM-P-08「把已识别的不确定性当作已排除」。
  FAM-P-06「文档与实现漂移」因本轮两个新事件由 2 涨至 4。
- 新增预防措施 PRE-10（标签必须由数据推导）、PRE-11（按名字取不按位置取）、
  PRE-12（第三方参考必须先预检再安全克隆）。

仅数据与文档变更，**无运行时行为变化，不需要重启**。

## 0.8.1

### Fixed

- **探针的 `command` 标签是手写的列表，加了第六层之后仍在列五层**——正是本项目反复抓到的
  「描述与实现漂移」，而且是被记录这个缺陷的那个文件犯的。现在标签**由实际跑过的层推导**，
  并加了守卫断言标签包含每一层，已双向验证。

## 0.8.0

**P2 + P3，外加一项方法论修正。**

### Added — P3：git 协议作为第二条路线

在此之前，**九个工具全部走 `gh`，`gh` 是唯一的单点故障**：二进制不在 PATH、没登录、或网络
被挡，九条错误信息就替代了九个工具。

新增 `lib/routes.js`，用 git 协议回答不依赖 `gh`、也不依赖令牌的那部分问题：

- `gitRouteStatus` —— git 可用吗？origin 是 GitHub 吗？
- `listPullHeads` —— `git ls-remote` 列出 `refs/pull/<n>/head`
- `findPullByHeadSha` —— **把本地 HEAD 的 sha 与 PR head ref 匹配，得到 PR 编号**
- `headSha` —— 工作区当前 HEAD

**它救回的是胶囊最关心的那个问题。** 公开仓库的 `git ls-remote` **不需要任何凭据**，
所以 `gh` 挂了、没登录，胶囊仍能显示 PR 编号。

**边界写死在类型里**：这条路只读 refs，**拿不到标题、状态、评审**。所以回退结果带
`via: 'git'`，标题为空、状态为空——客户端遇到空状态使用**中性色**而不是绿色。
**把未知状态渲染成「open」就是撒谎**，这个取舍有测试钉住。

- 探针从 5 层变 6 层，新增 `git protocol route`：它回答的是「gh 死了还剩什么」。
- 客户端新增 `ghk-pr-unknown` 样式。

### Added — P2：胶囊的注意力感知刷新

`visibilitychange` + `focus` 时重新拉取。

**刻意不做固定轮询**：分支/PR 变化极少（是人跑 `git checkout` 才会变），而每次拉取要跑
一次 `git rev-parse` 加一次 `gh pr list`。参考实现每 3 秒轮询，是因为它还要跟踪工作区
改动——那个确实会动。我们跟随的是「用户看回来了」这个真正的信号。

并发保护：新请求会 abort 旧的，且**被 abort 的请求不得覆盖新请求即将写入的状态**。

### Added — 方法论：`tools/repo-recon.mjs`

**读 README 就当知道实现，是错的。** 三阶段：

1. **预检（不下载任何字节）** —— 读元数据与文件树，找会执行的东西
   （`.gitmodules`、`.gitattributes` 的 filter、`binding.gyp`、`setup.py`、`install.sh`），
   并逐字读 `package.json` 的安装钩子。**判级要克制**：有 `package.json` 只是 info。
2. **克隆（关掉所有执行面）** —— 浅克隆、单分支、无 tag、**无 submodule**、
   符号链接写成文本、跳过 LFS smudge、hooks 路径改道到空目录。
3. **扫描真实字节 + 彻底清除** —— 只读扫描；`--purge` 删除并独立复核无残留。

### Fixed

- **探针的 `repo` 字段用了 `layers.at(-1)`**。追加第六层之后，它开始报告 git 路线而不是
  workspace repository。改为**按名字查找**——位置假设会被新层悄悄打破，名字不会。
  探针自己的测试抓到了这个回归。
- `lib/routes.js` 的注释里写了 `refs/pull/*/head`，其中的 `*/` **提前关闭了块注释**，
  文件直接语法错误。注释里已改用 `<n>` 占位，代码里的真实 refspec 保留通配符。

## 0.7.0

**P1：指导层。** 九个工具回答「能调用什么」，不回答「什么时候该用哪个、按什么顺序、需要什么证据、
什么时候该停、路径坏了怎么办」。这一版补的是那一层。

### Added

- **系统提示词 section** `TOOL_GITHUB`（order 3200）——六条规则，每条都是 schema 说不出来的：

  1. 报告 GitHub 坏了之前先跑 `github_auth probe`（`status` 报配置，`probe` 报当下可用性，两者会背离）
  2. 不要在失败的 `gh` 调用上重试循环——跑一次探针，报出断掉的层
  3. 优先用类型化动作而非 `github_api` 逃生舱（各子命令的 `--json` 字段词表并不通用）
  4. 破坏性动作会询问用户，`confirm: true` 是你的意图而非他们的同意
  5. 写之前先读（`github_pr view` 先于 `merge`）
  6. 分支不等于 PR（`github_pr status` 报的是当前分支的 CI）

  **order 3200 不是随手取的**：官方的工具类 section 占据 1000–3100 带
  （`TOOL_BASH` 1000 … `TOOL_COMPUTER_USE` 3000、`MCP_SERVERS` 3100），
  所以插件工具 section 落在 3200——内置工具与 MCP 之后、`TOOLS_SDK`（5000）之前。

- **三个按需加载的 skill**，每个都带证据要求和**明确的停止条件**：
  - `github-pr-review` —— 读 diff、CI 与变更文件之后再评论；列出「什么结论需要什么证据」
  - `github-ci-triage` —— 先定位失败步骤再读日志；区分真实失败与基础设施抖动
  - `github-issue-to-pr` —— 从 issue 到 PR，含「不要手工关 issue」等约束

- `lib/deferred.js`（**重构**）：把「等服务出现再安装」的机制从分支路由里抽出，
  供分支路由与指导层共用。这个机制此前花掉三轮诊断，**复制成两份是让它分叉的最快方式**。

- `tools/probe-guidance.mjs`（45 项，已入门禁）：校验 section 名不占用官方保留名、
  order 在工具带内、文本长度在预算内、每条规则都点名工具、skill 名 kebab-case 且
  front matter 与注册名一致、每个 skill 都有工作流与停止条件。

- 诊断路由新增 `guidance` 字段：报告**运行中**是否真的注册了 section 与技能。
  指导层没有自己的界面——section 在不在提示词里、技能在不在目录里，**从外面完全看不见**，
  这正是它会静默失败的原因。

### Changed

- 分支路由改用 `installWhenAvailable`。路由仍归 `ctx.effect` 所有（原有回归测试改为断言
  **性质**：销毁插件创建的 effect 必须释放两条路由，而不是断言 effect 的数量与下标）。
- 指导层的状态改为**每次调用返回的实例对象**，不再是模块级单例。两个原因：两半都是惰性注册，
  答案随时间变化；模块级单例会被进程内所有上下文共享，使**测试顺序决定测试结果**。

### Notes

- 无 `systemPrompt` 或 `skills` 服务的组合（headless）照常工作：两半都不注册，
  工具一个不少，`installGuidance` 如实报告「什么都没装」。

## 0.6.0

**P0：连通性探针。** 起因是在核对生态同类插件时发现的架构弱点——本插件只有一条路线（`gh` CLI），
**`gh` 一旦不可用，八个工具全部失效**，而 `github_auth status` 只报告「装没装、有没有凭据」，
不报告「现在到底能不能跑通」。

### Added

- **`github_auth probe`** —— 五层梯子，逐层隔离、逐层计时：

  | 层 | 命令 | 失败的典型原因 |
  |---|---|---|
  | gh executable | `gh --version` | 未安装，或装在 PATH 之外（用 `ghPath` 指定） |
  | credential chain | 进程内解析 | 四层凭据链一层都没命中 |
  | gh login | `gh auth status` | gh 自身没有该 host 的登录 |
  | **API round trip** | `gh api rate_limit` | **凭据存在但被拒、token 过期/缺 scope、代理拦截** |
  | workspace repository | 工作区 remote 解析 | 工作区没有 GitHub remote，也没配 `defaultRepo` |

  三个设计决定：

  1. **任一层失败都不终止探针**——目的是显示「走到了哪一步」，所以在第一处失败就中止是可耻的。
     抛异常的层也会被捕获为该层的失败，其余层继续跑。
  2. **整体判定跟随 API 往返**。前四层全绿而往返失败，正是这个探针存在的理由；
     反过来，凭据链缺失但 `gh` 自身登录可用时，整体仍报「可用」——梯子上会标红，判定不会说谎。
     这个取舍有测试钉住，避免将来悄悄漂移。
  3. **`recommended` 指出修哪一处**，并且指名具体配置键（`ghPath` / `defaultRepo`）或具体命令，
     「检查你的网络」不算建议。

  实测输出：

  ```
  [ok]  gh executable       88 ms  gh version 2.89.0 (2026-03-26)
  [ok]  credential chain     0 ms  source=gh-cli
  [ok]  gh login           654 ms  ✓ Logged in to github.com account <account> (keyring)
  [ok]  API round trip     555 ms  core 4968/5000 remaining
  [ok]  workspace repository 0 ms  cli/cli
  ```

- `tools/probe-connectivity.mjs`：探针的端到端验证（19 项），已纳入 `npm run verify`。
  它不靠断言 argv——探针没有 argv——而是**分别驱动每一层的失败**：用一个只回答 `--version` 的
  假运行器验证「第一处断点被正确命名」，用抛异常的 `describeAuth` 验证「抛异常的层不会拖垮探针」。

### Notes

- `github_auth` 的 `readOnlyActions` 加入 `probe`。

## 0.5.0

执行复盘报告中的行动项 A-01…A-08。这一版的重点不是功能，而是**把已读到的约束变成会失败的检查**。

### Added

- **诊断路由** `GET /dsh-github-toolkit/diagnostics`。存在原因是实测发现：**插件日志不落盘**——
  对 `DSH_HOME`、`%APPDATA%`、`%LOCALAPPDATA%`、`%TEMP%` 与安装目录的穷尽扫描中，含插件名的
  1075 个候选文件全是清单、pnpm 日志、`node_modules` 与 Chromium Code Cache，没有一行插件输出。
  该路由返回**运行中世代**的版本、四个服务的存在情况、已注册路由与工作区数量，并同样经过鉴权。
- `tools/verify-params.mjs`（**A-01 / PRE-09**）：断言每个声明参数都真的改变命令行。
  184 项断言、**0 未覆盖**，并复刻注册表的 `--repo`／`--json` 注入。
- `tools/check-profile.mjs`（**A-04**）：换装后一致性校验。安装不是原子的——实测中
  `remove_bundle` 成功而 `install_bundle` 因 Windows 文件锁失败，profile 落回**已卸载**状态
  且无人报告。此脚本检查 manifest、bundle 列表、磁盘版本与残留临时文件。
- `tools/knowledge-index.mjs` + `docs/KNOWLEDGE.md`（**A-07**）：12 条知识资产，
  由 41 项结构断言守护（编号唯一且连续、必备字段齐全、来源可追溯、索引与正文一致）。
- `tools/recurrence-report.mjs` + `docs/recurrence.json`（**A-08**）：问题族复发率看板。
  实测 2026-Q4：**6 个根因族中 4 个为红**，即同一根因在同一场会话内就已复现多次。
- `docs/WORKFLOW.md`（**A-06**）：门禁、参数规约、双向验证、换装、诊断顺序、批量节奏、经验库维护。
- `npm run verify` 现在是完整门禁：6 项 Schema 探针、15 项 DSL 探针、bundle 守卫、
  参数有效性、知识库、复发看板、99 项离线测试、36 项实机探针（**A-02**）。

### Fixed

`verify-params` 首次运行报告 26 个失败，其中**绝大多数是它自己的假警报**——基线参数没带上
动作的必填项，又把没有动作前缀的描述当成「适用于每个动作」。加上双向验证后，
它最终暴露出 **4 个真缺陷**：

- **`github_search` 的 `kind` 是一个死参数**。描述写着「What to search (default repos)」，
  看起来是这个工具的主要选择器，但**没有任何动作读取它**——传 `kind: "issues"` 会静默搜索仓库。
  已移除：动作 id 本身就是那个选择器，两者并存还可能互相矛盾。
- **`github_issue edit` 忽略 `label`**。`create` 有 `labels ?? (label ? [label] : [])` 回退，
  `edit` 没有，所以对 edit 传 `label` 什么都不会发生。已统一。
- **`github_release edit` 忽略 `latest`**。参数声明为 `create/edit`，但 edit 从未读取它。
  已实现（`gh release edit --latest`，对 gh 2.89.0 实测确认存在）。
- **`github_repo` 的 `name` 声明了 `rename`**，而 rename 读的是 `newName`
  （`gh repo rename [<new-name>]` 是位置参数）。
- **`github_actions` 的 `workflow` 描述写作 `workflow list/view/dispatch`**，
  映射不到真实动作 id，并且掩盖了 `list` 也读取该参数的事实。

同时修正了 `verify-params` 自身的三处问题：它现在接受「被 `check()` 拒绝的不完整基线」
（`pr comment` 就是这种正确形态）、对每个参数只解析一次描述（此前一个坏描述会产生 12 条重复失败）、
并**报告覆盖率**——静默跳过 210/304 个参数读起来像全都检查了。它的正则曾经不接受连字符，
导致描述里的未知动作名被静默降级为散文；这是**注入违规做双向验证**时发现的。

## 0.4.0

The browser half grows a pull-request status beside the branch name, and the two
bugs that blocked the first version are fixed.

### Added

- **The pill now carries the pull request for the checked-out branch**: a state
  dot and `#<number>` after the branch name, coloured by state — open, draft,
  merged, closed, or open with changes requested. The tooltip carries the state,
  the review decision, and the PR title.
- **The Host route returns the PR** alongside the branch, read with
  `gh pr list --head <branch> --state all --limit 1`. `--state all` because a
  branch whose PR just merged is exactly when the status is most useful.
- The PR lookup is **strictly best-effort**: a missing `gh`, an unauthenticated
  one, an offline network, a repository with no remote, or unparseable output all
  yield `pr: null`, and the branch stays readable. Tested against every one of
  those, plus a detached HEAD where no lookup is attempted at all.

### Fixed

- **The route was not owned by `ctx.effect`.** Its disposer was merely held, so
  disposing the plugin's fiber did NOT release the route and the next activation —
  the HMR path an install takes — failed with
  `webserver: duplicate exact route "/dsh-github-toolkit/branch"`. Registering
  inside `ctx.effect` ties the route to the fiber, per the reference's "register
  every resource inside `apply` with `ctx.effect` or `ctx.on`".
- **The route bypassed the app's authentication.** Measured: `/` answered 401 to an
  unauthenticated request while this route answered 200 with the branch payload. A
  named route is public by default; `connection.requestRejection` — documented as
  "apply Connection's Host/Origin checks and browser authentication to another Web
  route" — now refuses unadmitted requests with their status, without leaking the
  payload. The Host/Origin half is what stops a page in the user's browser from
  reading this over the loopback address.

## 0.3.6

- **Fixed the route leak.** The registration is now wrapped in `ctx.effect`, so
  disposing the fiber releases it. Verified by re-installing: the duplicate-route
  error that 0.3.4 and 0.3.5 hit on re-activation no longer occurs.

## 0.3.4

- **The route waits for `webServer` by listening.** `ctx.get('webServer')` in
  `apply` found nothing, and `ctx.inject(['webServer'], cb)` did not register the
  route either. `ctx.on('internal/service')` — the event Cordis emits for every
  service registration — installs the route when the service is up and on every
  later arrival, keeping the row's `inject` at `['tools']` so a headless profile
  keeps every tool.
- **Reverted a two-row split.** A second patch row naming
  `dsh-github-toolkit/web` reported "failed to import": the launcher's runtime
  resolution supplies a profile package by its exact name, so a bare subpath
  resolved nowhere. `verify-bundle` now rejects a subpath row.

## 0.2.4

Learned by reading the closest peer in the ecosystem rather than iterating alone:
`@perrylink/dsh-github` (22 stars, Apache-2.0, 0.7.20) — a GitHub plugin with
overlapping scope.

- **Added `engines.dsh`** (`>=0.2.0-0 <0.3.0`). The peer declares it and this
  plugin did not, so a runtime bump would have surfaced as an unexplained load
  failure instead of an upfront compatibility answer. `verify-bundle` now checks
  it exists.
- **Widened the `@deepseek-ai/dsh-tools` peer range** from `^0.2.0-rc.1` to
  `>=0.2.0-0 <0.3.0`. Measured with real semver: the old range BLOCKS
  `0.3.0-rc.1`, so the next dsh RC bump would have demanded a version exemption.
  The `-0` arm is the peer's idiom for admitting the next line's prereleases.
  The older arms the peer also carries (`>=0.1.2-rc.1 <0.2.0` and friends) are
  deliberately NOT copied: this plugin has only been exercised against
  0.2.0-rc.2, and claiming untested compatibility is a false claim.
- **Corrected two over-claims of my own.** `presentationMeta`/`presentResult`
  usage counts reported earlier were produced by a broken counting command
  (`-AllMatches | .Matches.Count | Measure-Object -Sum` returns 0 even when
  matches exist); the real counts are 8 and 11, not 10 and 8. And the result
  schema's per-property `required` is a DECLARATION, not measured run-time
  enforcement — `defineTool`'s wrapper does not reject a value that omits a
  required field, and whether the registry does is unmeasured here.

## 0.2.3

- **Fixed a contract violation the first live call exposed.** The registry
  materializes `arguments` as detached lossless JSON and **freezes** that value
  before policy begins, so resolving a ref sentinel by writing back into `args`
  threw `Cannot assign to read only property 'branch'`. Resolution now works on a
  detached working copy, and the caller's object is never rewritten.
- **Validation runs on the resolved values**, not on the sentinel text, so a name
  a sentinel produced is checked by the same rule as one the caller typed.
- **The offline test helper now freezes its arguments too**, mirroring the
  registry. It handed over a mutable object before, which is how 87 green checks
  shipped a call that failed the moment it ran for real. A named regression test
  pins the contract in both directions — the `@current` write and the `"*"`
  delete.

## 0.2.2

### Selecting a branch without repeating yourself

- **Added the `@current` and `@default` ref sentinels.** Any argument that names
  a git ref now accepts `@current` (the branch checked out in the workspace) or
  `@default` (the repository's own default branch), resolved before argv
  construction. Eleven action/parameter pairs, listed in one exported table
  (`REF_PARAMS`) rather than inferred from names — `ref` is a git ref on
  `github_actions dispatch` and a **credential** name on `github_auth`, so a
  name rule would rewrite a credential into a branch.
- **`github_actions list` defaults its branch filter to the workspace branch**,
  because that action exists to answer "why is CI red?" about the work in front
  of you. Pass `branch: "*"` to list every branch.
- **`github_pr list` deliberately does NOT default.** `gh pr list` shows every
  open pull request; a hidden base filter would remove the very thing the list
  is for. `@default` is available when you want it.
- **An applied default is stated in the result** (`[ref] branch: fix/ci (current
  branch)`), never silent. A filter that quietly narrows a list is how a caller
  concludes "nothing there" when there is something there.
- **An unresolvable sentinel stays as written** rather than being dropped, so gh
  rejects it loudly instead of the call quietly running against the wrong ref. A
  detached HEAD prints the literal `HEAD`, which is treated as "no branch".
- The plugin still wraps **no local git command**: switching your working tree
  remains `git checkout` through dsh's own shell tooling (docs §8.6).

## 0.2.1

Everything here was found by one question — "why can't the plugin select a
GitHub branch?" — which exposed that **five actions had never worked at all**.
They failed against real `gh` while the offline suite passed, because that suite
only asserted the argvs it chose to assert, and the live suite exercised `lib/`
modules rather than whole actions.

### Actions that had never worked

- **`github_repo branches`.** It declared `json: 'name,commit'` while building a
  `gh api` command, so the registry appended `--json` to a command with no such
  flag. Every call died with `unknown flag: --json`. `gh api` already emits JSON,
  so the field selection was both broken and unnecessary.
- **`github_repo branches` ignored its own `branch` parameter.** The description
  promised "inspect one when `branch` is given" and the builder never read it.
  Now `repos/{repo}/branches/{branch}`, with the name interpolated RAW — encoding
  the slash in `feat/x` as `%2F` makes the API answer 404 (measured).
- **`github_release list`** asked for `url`, which that command does not expose,
  so it failed with `Unknown JSON field: "url"`. Replaced with `isLatest`.
- **`github_search repos`** asked for `nameWithOwner`, `stargazerCount`, and
  `primaryLanguage` — all `gh repo list` vocabulary. `gh search repos` uses
  `fullName`, `stargazersCount`, and `language`.
- **`github_search commits`** asked for flat `message`/`committedDate`; that
  command nests them under `commit` and `committer`.
- **All five `github_search` actions** passed the query as one argument. gh
  quotes EVERY positional argument before joining them, so the whole query became
  a single quoted term and any query with a qualifier was rejected with
  `Invalid search query "( repo:\"cli/cli is:open\" )"`. Queries are now split on
  whitespace, quote-aware so `"a phrase"` stays one term.

### Branch selection wired where gh supports it

- `github_repo view` gained `--branch`.
- `github_repo clone` now puts `--branch` **after the `--` separator**: it is a
  GIT flag, and `gh repo clone` rejects it as an unknown flag before it.
- `github_pr list` gained `--base` / `--head` filters.
- `github_pr checkout` gained `--branch` (the local branch name).
- `github_issue develop` gained `--base`.
- `github_repo branches` without a `branch` now maps `limit` to `per_page`, which
  the endpoint otherwise ignores at its default of 30.

### Verification

- **New live guard:** every read-only action is now driven through the real
  registry against the real `gh`, asserting that gh rejects neither the command
  line, nor a JSON field, nor a search query. 21 probes, up from 14 checks. This
  is the check whose absence let five broken actions ship.
- Offline: 83 checks. Live: 36.

## 0.2.0

Conformance pass against the official tool-authoring reference and against the
shipped production tool plugins (`@deepseek-ai/dsh-tool-bash`,
`@deepseek-ai/dsh-tool-fs`). No behaviour removed.

- **Added `LICENSE`.** The manifest declared `"license": "MIT"` without shipping
  the file; every shipped plugin ships one.
- **Added `README.zh.md`** and restructured `README.md` around the official
  shape (summary, use-this-package, configuration, known limitations, dev notes).
- **Added `isConcurrencySafe`** to read-only actions, so independent reads may
  run in parallel instead of serialising every call.
- **Added `presentationMeta`** projecting a bounded card fact set (`ok`,
  `exitCode`, `url`, `number`, …) that replay can reproduce without persisting
  the whole result value.
- **Added `presentResult`**, so a completed call renders its outcome rather than
  falling back to the generic line.
- **`presentCall` now reports a real `kind`** (`read` / `search` / `other`)
  instead of always `other`.
- **Destructive actions now ask through the approval seam** (`tools/pre-execute`
  → `{ kind: 'ask' }`) in addition to requiring `confirm: true`. Until now the
  only gate was a model-supplied flag, which is intent, not consent.
- **Added background jobs.** `github_actions` `runLog`/`runWatch` and
  `github_release` `upload`/`download` accept `run_in_background: true`, which
  admits a `ctx.jobs` job, returns its id at once, and applies no background
  timeout. The handle is the programmatic field `data.jobId`, the job streams its
  output into the job's ring so `job_output` can read it, and `job_kill` stops
  it. Without a composed job registry the call reports
  `background jobs unavailable` instead of silently running in the foreground.
  The work starts inside the registry's `run()` callback, so a rejected
  admission never leaves a live process behind.
- **Fixed the background job owner.** `JobSpec.owner` is a `SessionId` that the
  registry resolves with `agents.get(session)`; passing the Agent object produced
  `session "[object Object]" has no live agent` on a real call.
- New config: `approvalForDestructive` (default `true`).
- New `verify-bundle` checks: LICENSE and bilingual README present and valid,
  `locale/*.json` uses the `meta` wrapper, every bare `@deepseek-ai/*` import is
  declared, and every registered tool declares the presentation and concurrency
  hooks.

## 0.1.1

- **Fixed the `locale/*.json` shape.** `readPluginMeta` reads `meta.title` and
  `meta.description`; the files shipped flat `title`/`description`, so the
  display text was ignored and the plugin card fell back to the package name
  (which the settings page shortens to `github-toolkit`).
- Added the `LICENSE` file to `manifest.files` handling.
## 0.1.0

- First installable release: eight `github_*` tools over the `gh` CLI, a layered
  credential chain, GitHub Device Flow authorization, workspace-bound repository
  detection, and a guarded REST escape hatch.
- Declares `peerDependencies` on `@deepseek-ai/schemastery` and
  `@deepseek-ai/dsh-tools`. This is required, not optional: the launcher's
  runtime resolution only supplies a bare package a plugin declares, so without
  these the plugin fails to import with `ERR_MODULE_NOT_FOUND`.
