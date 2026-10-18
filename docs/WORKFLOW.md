# 工作流与操作规约（Workflow）

本文件把复盘报告中的行动项（A-01…A-08）固化成可执行规约。
每条规约都对应一个**已落地的守卫或脚本**，没有守卫的条目会标注为「人工」。

---

## 0. 工具分层：shell 只用来发起一行命令

**这一节来自一次外部复盘，它解释了这个项目里反复出现的一类失误。**

先纠正一个前提：**文件编辑工具和 shell 不在同一层**。用编辑工具改文件**不经过 shell**——
这个项目里所有编辑都没出过问题，出问题的**全部是用 shell 做它不擅长的事**。

| 场景 | 用什么 | 为什么 |
|---|---|---|
| 改文件 | **编辑工具**（不经 shell） | 直接落盘，没有引号/编码/路径层 |
| 一行命令（`cd` / `git status` / `node tools/x.mjs`） | 任意 shell | 没有可出错的语法 |
| **多行 / 模板字符串 / 字符串处理 / 路径拼接 / 统计** | **写进 `tools/*.mjs` 再调用** | shell 在这四件事上**各有各的坑** |

**本项目的「脚本层」就是 `tools/*.mjs`。** 规则：

> **任何会被报出的数字，必须来自 `tools/` 里的脚本，不能来自 shell 管道。**
> 这个脚本要能跑两次并比对。

### 已实测的失误（全部是 shell 层，全部没有报错）

| 类别 | 失误 | 后果 |
|---|---|---|
| **测量语义** | `Measure-Object -Line` **不计空行** | 反复少报行数（852 vs 真实 1073；1047 vs 1345） |
| | `$LASTEXITCODE` 在管道之后读取 | 读到的是管道状态；**所有 npm 包都被报成「不存在」** |
| | `-SimpleMatch 'Fixed\|fixed'` | `\|` 是字面量，计数恒为 0 |
| | `-AllMatches \| .Matches.Count \| Measure-Object -Sum` | 真实匹配上返回 0 |
| **引号/插值** | 双引号串里的 `` `${VAR}` `` | **被 PowerShell 当自己的变量**插入，值变成 `" @ "` |
| | 反引号 | 被当作转义符，`` `readdir` `` 变成 `eaddir` |
| | here-string 里放 JS 模板字符串 | 同上 |
| **路径** | `-Filter 'pnpm-lock.yaml.*'` | Windows 8.3 短名匹配**命中了真实文件**，删掉了 profile 的 lockfile |
| **语法/多行** | 用 shell 做行级切片手术 | 产生重复 `/**` 与多余 `*/`，文件语法错误 |

**这四类里，前三类会报错，第四类不会——它给出自信的错误答案。**
那才是最危险的：报错会停下你，错误的数字会被报出去。

### 因此

- **统计** → `node tools/measure.mjs`（本规则的产物，唯一口径）
- **profile 状态** → `node tools/profile:check`
- **第三方仓库** → `node tools/repo-recon.mjs`（预检 → 安全克隆 → 扫描 → 清除，全在一个脚本里）
- **研究一个仓库** → 先 `repo-recon --keep`，再**用编辑/读取工具读文件**，不要在 shell 里 grep 拼接
- **shell 里只留**：`cd`、`npm run <script>`、`node tools/<script>.mjs`、单条 `git`

**判据**：如果一条命令里出现了管道 + 字符串处理 + 数字，它就该是一个脚本。

### 什么情况下 PowerShell 反而是对的

不是所有事都该躲开 shell。**跟 Windows 系统打交道时 PowerShell 更直接**：

| 场景 | 为什么用 PowerShell |
|---|---|
| 注册表 / 服务 / 证书 | 其它 shell 没有等价物 |
| 文件时间戳 / ACL / 短名 | `Get-Item`、`Get-Acl` 比外部工具全 |
| COM 自动化（Word/Excel） | Windows 原生路径 |
| 调用 Windows 原生程序 | 无需 MSYS 转换层 |

**规则**：*跟 Windows 系统打交道用 PowerShell；跟代码仓库和文本文件打交道用脚本。*

### 关于「换 Git Bash」——本项目已核实：**不适用**

外部复盘的首条建议是「把宿主切到 Git Bash，90% 的坑消失」。**本项目实测结论是否定的**：

| 检查 | 结果 |
|---|---|
| 我的工具面有哪些 shell | **只有 `pwsh`**（44 个工具里无 `bash`） |
| 装机里有没有 bash 工具包 | **有** —— `@deepseek-ai/dsh-tool-bash` |
| 它在 profile 里吗 | 在，但顶层 `disabled: true`，与 `tool-pwsh` 成对出现，由 preset 按需启用 |
| 我能自己改吗 | **不能** —— 工具面由 profile 组合决定，不是运行时可选项 |

**所以这条建议对本项目不成立**，而它成立的前提（人在编辑器里改 `terminal.integrated.defaultProfile`）也不适用于一个只有固定工具面的 agent。

**这不影响它的其余部分**：那些讲的是「别用 shell 做复杂事」，与本项目 §0 的结论一致，
只是本项目把「复杂逻辑的归宿」定为 `tools/*.mjs` 而不是 Python——**因为这里已经有 15 个 `.mjs`**。

### 编码：本项目实测的结果与一个潜在风险

外部复盘称 `Set-Content` 写 BOM、`>` 写 UTF-16LE。**逐条实测**：

| 断言 | 实测 | 结论 |
|---|---|---|
| `>` 重定向写 UTF-16LE | 前 4 字节 `255,254,112,0` | ✅ **成立** |
| `Set-Content` 写 UTF-8 BOM | 前 3 字节 `116,101,115`（无 BOM） | ❌ 本机不成立 |
| `Add-Content` 中文写 GBK | 4 个汉字 = **12 字节**（UTF-8），非 8 字节 | ❌ 本机不成立 |

**为什么本机不成立**：系统 ANSI 代码页是 **65001（UTF-8）**，PS 5.1 的默认编码回退到它。
**所以我现在的文件是干净的，但那是系统设置带来的，不是工具保证。**
关掉那个 Windows 设置，本项目所有 `Set-Content` 会立刻改成写 GBK，**没有报错、没有可见症状**，
直到有人用 UTF-8 阅读器打开。

**这就是规则写作「用编辑工具写文件」而不是「用配置正确的那个 shell 写文件」的原因。**

守卫：`node tools/check-encoding.mjs [额外路径…]` —— 检查 BOM、NUL 字节、UTF-8 有效性、混用行尾。
**默认只覆盖包内文件**；包外的文档（如复盘报告）需要显式传路径，这一点写在工具头部。

---

## 1. 门禁分层：`verify` / `release`（A-02 + A-09 的产出）

> **口径更正（2026-10-16）。** 本节原标题是「交付门禁：`npm run verify`」——
> **那与事实不符。** 独立审计指出 `verify` **不包含** `encoding`、`report:check`、
> `profile:check`，**而文档和 CHANGELOG 一直称它是「交付门禁」**。
> 一个声称覆盖全部而实际只覆盖一部分的闸门，比一个说清边界的闸门危险得多。

| 层 | 命令 | 覆盖 | 何时用 |
|---|---|---|---|
| **封闭** | `npm run verify:offline` | 不依赖网络与装机 | 任何改动 |
| **仓库** | `npm run verify` | 上表全部 + 实机探针 | 打包前 |
| **发布** | `npm run release` | `verify` + 编码 + 报告 + 已装一致性 + 已装 vs 源码 | **交付前** |

**为什么分三层而不是一层全塞进 `verify`**：`encoding` 与 `report:check` 依赖**包外**文件
（复盘报告），`profile:check` 与 `compare-installed` 依赖**这台机器已装了什么**。
**一个干净 checkout 上跑不通的检查，不该让源码门禁失败**——那会训练人忽略它。

**`npm run verify` 覆盖：**

| 阶段 | 命令 | 覆盖 |
|---|---|---|
| 1 | `tools/probe-schemastery.mjs` | Schema DSL 行为（6 项） |
| 2 | `tools/probe-define-tool.mjs` | 工具定义 DSL 行为（15 项） |
| 3 | `tools/verify-bundle.mjs` | manifest、导出、patch 行、客户端半身约束 |
| 4 | `tools/verify-params.mjs` | **每个声明参数都必须真的影响命令行** |
| 4b | `tools/probe-guidance.mjs` | **指导层**：section 名、order、规则点名工具、技能形状与**引用完整性**（113 项） |
| 5 | `tools/knowledge-index.mjs` | 经验库结构完整性（16 条、53 项） |
| 6 | `tools/recurrence-report.mjs` | 问题族复发率与预警 |
| 7 | 离线测试 | 101 项 |
| 8 | `test/live-readonly.mjs` | **逐只读动作实机探针**（36 项） |

**为什么第 4 和第 8 阶段是强制的**：曾有 5 个动作从 0.1.0 起从未成功执行过一次，
而当时 97 项离线测试全绿。抽样断言与模块级测试无法发现「动作从未跑过」。

**`npm run release` 追加：**

| 检查 | 回答什么问题 |
|---|---|
| `npm run encoding` | 每个文本文件的编码（含包外报告——需显式传路径） |
| `npm run report:check` | 复盘报告的数字与实测是否一致 |
| `npm run profile:check` | 已装包与 profile manifest 是否自洽 |
| `node tools/compare-installed.mjs` | **已装副本与源码是否逐字节一致** |

**最后一项是审计指出的缺口**：0.9.5/0.9.6 那次源码领先一个版本，
**项目里没有任何检查能发现**，是审计者手工比对两处 `package.json` 才看到的。

---

## 2. 参数有效性（PRE-09）

**规则**：参数描述中位于第一个冒号之前的部分，是**动作声明**，必须使用真实动作 id。

```
✅  view/branches/clone: a branch name.
✅  requiresRepo: target repository as "owner/name".
✅  needs: the pull request number for actions that target one.
❌  workflow list/view/dispatch: …      ← 映射不到 workflowList/workflowView/dispatch
❌  create/rename: repository name…      ← rename 实际读 newName
```

**两个关键字**引用动作已经声明的结构性事实，避免手写清单漂移：

| 关键字 | 含义 |
|---|---|
| `requiresRepo` | 该动作设置了 `requiresRepo: true` |
| `needs` | 该动作把本参数列入了 `needs` |

守卫会同时输出**覆盖率**：声明了但描述不指名动作的参数会被列为「NOT covered」，
不允许沉默——第一版守卫静默跳过了 304 个参数中的 210 个，读起来却像全都检查了。

---

## 3. 守卫双向验证（PRE-06）

新增或修改任何守卫后：

```
写守卫 → 注入违规 → 确认守卫 FAIL → 还原 → 确认守卫 PASS → 记录两次结果
```

本轮这条规则直接救回两次：`verify-params` 的正则不接受连字符，导致描述里的
**未知动作名被静默降级为散文**；去掉连字符后注入违规才被正确捕获。

---

## 4. 换装流程（A-04）

**已知风险（实测）**：安装不是原子的。`remove_bundle` 成功而 `install_bundle` 可能因
Windows 文件锁失败：

```
[EPERM] rename '…\profiles\desktop\package.json.2067520508' -> '…\profiles\desktop\package.json'
```

此时 profile 处于**已卸载**状态，而**没有任何地方会报告**。

**流程（顺序不可换，2026-10-16 修正）**

1. **打包必须在源目录之外**（`D:\dsh\packages\`）。
   教训：曾因在源目录内打包导致 `test/` 与 `tools/` 被清空。
2. **打包后不得立即删除旧 tarball。**
   教训（P-23）：删掉 0.8.1 之后 `remove_bundle` 撞上 EPERM，profile 的依赖指向了一个
   已不存在的文件，`install_bundle` 随之 ENOENT——**一个可恢复的文件锁故障被升级成不可恢复**。
3. `remove_bundle`（EPERM 则重试一次）
4. `install_bundle`
5. **无论成功失败都跑**：`npm run profile:check`
6. **校验 6/6 通过之后，才允许删除旧 tarball。**

| 检查项 | 失败含义 |
|---|---|
| manifest 声明了依赖 | 换装中途失败，插件已被移除 |
| bundle 列表包含它 | 不会加载 |
| 包在磁盘上 | pnpm 未完成 |
| 已装版本 == 声明的 tarball | 装的是旧包 |
| 无 `package.json.<数字>` 残留 | 有一次被中断的换装 |

5. 若是 `EPERM`：**重试一次**（锁通常是瞬时的），然后重新跑第 4 步。
**工具链的不可恢复状态（P-23 记录）**：当依赖指向一个缺失文件时，`install_bundle` 会返回
`ambiguous-install`（依赖已声明，工具分不清「安装」还是「启用」）**并拒绝处理**——
而恰恰是这个状态必须处理。恢复路径只有**手工编辑 profile 的 `package.json`**，
再跑 `profile:check` 确认。另一条只会得到 `ENOENT`。

7. 替换已安装包**必须重启应用**才能加载新世代；新 bundle 可能通过 HMR 激活。
   运行中的世代可以用诊断路由确认版本。

---

## 5. 诊断顺序（A-05）

**背景（已穷尽验证）**：插件日志**不落盘**。对 `DSH_HOME`、`%APPDATA%`、
`%LOCALAPPDATA%`、`%TEMP%` 与安装目录的扫描中，含插件名的文件全是清单、pnpm 日志、
`node_modules` 与 Chromium Code Cache——**没有一行插件输出**。

因此诊断走路由，不走日志。顺序见 `KNOWLEDGE.md` K-10：

```
1. 版本核对：磁盘版本 vs 进程启动时间（或用诊断路由问运行中的版本）
2. 外部探针：GET /dsh-github-gate/branch?sessionId=x
   ├─ 404 → 未注册（host 侧）
   ├─ 401 → 已注册且鉴权生效（正常）
   └─ 200 → 已注册但未鉴权（安全缺口）
3. 激活告警含 failed to import → 查裸依赖声明与 patch 行是否用子路径
4. 客户端 → 硬刷新；看故障态（!）与悬停文案
5. 换装一致性 → npm run profile:check
```

第 1、2 步合计 < 30 秒，且**不需要浏览器**。

**诊断路由**：`GET /dsh-github-gate/diagnostics`（同样需要鉴权）返回
运行中世代的版本、四个服务的存在情况、已注册路由、工作区数量。

### 第 0 步（最先做）：连通性探针

```bash
npm run probe:connectivity          # 开发期：端到端验证探针自身
```

或在会话内直接调用 **`github_auth probe`** —— 五层梯子，逐层计时：

```
[ok]  gh executable       88 ms  gh version 2.89.0 (2026-03-26)
[ok]  credential chain     0 ms  source=gh-cli
[ok]  gh login           654 ms  ✓ Logged in to github.com account <account> (keyring)
[ok]  API round trip     555 ms  core 4968/5000 remaining
[ok]  workspace repository 0 ms  cli/cli
```

**为什么它是第 0 步**：`github_auth status` 报告的是**配置**，探针报告的是**当下可用性**。
两者在这个项目里曾经背离——`status` 全绿而所有动作都跑不通。

**读法**：整体判定跟随 **API round trip**。若它失败，`brokenAt` 会指名第一处断点，
`recommended` 会给出具体修复动作（指名 `ghPath` / `defaultRepo` 或具体命令）。
若它成功而其他层标红，路径仍然可用——梯子上的红色是**信息**，不是矛盾。

---

## 6. 批量验证节奏（A-06）

**规则**：同一世代内尽量合并多个修复，一次打包、一次安装、一次重启。

| 指标 | 本轮实测 | 目标 |
|---|---|---|
| 版本数 | 10 | — |
| 用户重启次数 | 8 | — |
| **版本数 / 重启次数** | **1.25** | **≤ 1.5（保持）** |
| 插件管理器操作 | 56 | ≤ 2×版本数 |

**例外**：涉及**激活路径**的改动（manifest、patch、依赖声明）必须单独验证——
它们失败时插件整体不激活，与其他修复混在一起会污染判断。

**代价约束**：一次「安装＋重启」的端到端耗时是全部收益测算的分母，
当前为【待验证】（见复盘报告 H-03）。

---

## 7. 经验库维护（A-07）

| 动作 | 时机 | 责任人 |
|---|---|---|
| 新增 | 出现新问题族 / 形成可复用 SOP / 技能优化任务卡完成 | AI Agent |
| 审核入库 | 上述后 3 日内 | 用户 |
| 更新 | 流程变更、问题复发、工具升级、上游契约变更 | AI Agent |
| 校验 | 每次 `npm run verify` | 自动 |
| 淘汰 | 连续 4 个季度复用 0 次，或适用场景消失 → 归档 | 用户 |

**入库触发条件（必须沉淀）**：
1. 出现新的问题族；
2. 某问题的修复方式可复用于未来任务；
3. 技能优化任务卡完成；
4. 外部证据推翻了既有结论。

结构校验由 `npm run knowledge` 执行：编号唯一且连续、必备字段齐全、
来源编号可追溯、索引与正文一致、锚点可跳转。

---

## 8. 复发监控（A-08）

```
npm run recurrence              # 当前季度看板
node tools/recurrence-report.mjs --quarter 2026-Q4
node tools/recurrence-report.mjs --json
```

**语义**：复发 = 该族在统计周期内的**第 2 次及以后**发生。首次发生是缺陷本身，不是复发。
（第一版把首次也算作复发，导致所有族全红——那样的看板没人会看。）

| 等级 | 触发 |
|---|---|
| 黄 | 同族 1 个季度内复发 1 次 |
| 橙 | 1 个季度内复发 2 次 |
| 红 | 1 个季度内复发 ≥3 次，**或**复发中含 P0/P1 |
| 绿 | 无复发 |

**红色必须**：启动根因再分析，1 周内提交整改报告。
**关闭条件**：措施执行后连续 3 个统计周期复发率为 0，且责任人/验收人/质量三方确认。
关闭后仍纳入季度抽样复查。

**当前实测**：2026-Q4 六个族中 **4 个为红**（FAM-P-01 复发 3 次、FAM-P-02 复发 5 次、
FAM-P-03 与 FAM-P-06 各 1 次且含 P1），2 个为绿（仅单次发生）。
这是本复盘最硬的证据：**同一根因在一场会话内就复现了多次**。

---

## 9. 指导层（P1）

**为什么它是独立的一层**：九个工具回答「能调用什么」，不回答「什么时候用哪个、按什么顺序、
需要什么证据、什么时候该停」。缺了后者，工具越好越容易被误用。

| 机制 | 内容 | 成本 |
|---|---|---|
| 系统提示词 section `TOOL_GITHUB`（order 3200） | 六条绝不能漏的规则 | **每一步都付费** |
| 技能 `github-pr-review` / `github-ci-triage` / `github-issue-to-pr` | 三个完整工作流，含证据要求与停止条件 | 按需加载 |

**维护规则**

1. **能写进 schema 的不要写进提示词** —— 每一行都在每一步消耗 token，预算 2400 字符。
2. **每条规则必须点名工具或动作** —— 空话不配占提示词。由 `probe:guidance` 强制。
3. **改 section 名或 order 前先读宿主的保留名表** —— 同层重名会抛；`getSectionOrder` 只认
   宿主保留名，对插件名返回 `undefined`，而**非有限 order 会抛**。插件必须自己给数字。
4. **每个技能都要有停止条件** —— 不知道何时该停的 agent 会一直调用工具。
5. **改完必须跑双向验证** —— 注入一次违规，确认守卫会失败。

**它是否生效怎么看**：指导层没有界面。诊断路由会报告**运行中**的实际状态：

```json
"guidance": { "promptSection": "TOOL_GITHUB @ 3200", "skills": ["github-pr-review", ...] }
```

`promptSection: null` 表示 section 没注册（该组合可能没有 `systemPrompt` 服务），
这与「注册了但模型没遵守」是两个完全不同的问题——**先分清是哪个，再谈改规则**。
---

## 10. 第三方参考：读代码，不读 README（K-15）

**这一节记录一次方法论修正的真实后果。**

此前对三个参考插件的分析**只基于 README**，并在报告里注明了「未读代码」——然后继续用那些
描述决定做什么。把 README 当作实现证据，就是本项目复盘报告里批过的「未经实测即下结论」，
只是换了个地方犯。

### 流程

```
预检（不下载任何字节）  →  安全克隆（关掉所有执行面）  →  只读扫描  →  彻底清除 + 独立复核
```

- `node tools/repo-recon.mjs owner/name` —— 全流程，扫完自动删
- `--preflight` 只判断不下载 ／ `--keep` 保留供阅读 ／ `--purge` 彻底清除 ／ `--list` 现况
- **绝不在克隆目录里执行任何东西**：不 install、不 build、不 test、不跑脚本

### 读真实代码推翻的三条认知

对 `dsh-github-router` 做完整侦察（预检 SAFE → 48 文件 → 无安装钩子、无符号链接）后，
逐文件读实现，与 README 的描述对照：

| README 说 | 代码里是 | 影响 |
|---|---|---|
| 路线顺序 `api → gh → **git → html** → mirrors` | `recommendation` 的实际顺序是 `api-direct → api-proxy → gh → **html → git** → mirrors` | **git 与 html 是反的。**照 README 抄会抄错优先级 |
| 「`github_probe` 沿路线梯子依次尝试」 | 探针**并行跑所有路线**，输出 `checks[]` 矩阵 + `recommendation` 列表 | 它不是一个 fallthrough 链。我的 P0 探针是「逐层隔离」——**与它一致**，这算相互印证 |
| 注释称 section order 118 属于「100–129 工具指导带」 | 装机实现的 `SECTION_ORDERS` 表**没有这个带**；110/115/120 属于 **`CONTEXT_ORDERS`**（另一张表） | 两张表容易混。**我的 3200 是有表可依的**，它的 118 依据不成立（order 只是排序键，仍能用） |

### 同时确认的

- `systemPrompt.section` 与 `skills.register` 是**官方机制**，不是我发明的——两边都在用
- 它的探针 `run()` 对每层 try/catch 并记 `{route, ok, ms, detail}`，**与我的 P0 设计一致**
- `git ls-remote ... refs/pull/<n>/head` 可**无凭据**读取 PR head —— 这条已采纳为 P3 的第二条路线

### 纪律

**结论要能追溯到代码行。** 一条无法指到具体文件的说法，只能写成【据 README】，
不能写成事实。这条和 S-06「外部证据核验」是同一条：**单一来源不得支撑结论**。
---

## 11. R2 独立审计：`npm run audit`

**A-09 的产出。** 这一节的存在理由是**一次实测**：项目此前一直把 `npm run verify` 退出 0
当作收敛，而那是 **R1 单次检查**。

**唯一一次派独立审计者的结果是 P-25**——113 项守卫全绿，而运行中的组合服务的是上一代技能。
**六个同类缺陷，全是「守卫绿、现实不一致」**：P-01、P-17、P-24、编码盲区、诊断字段、P-25。

### 口径

```powershell
npm run audit            # 打印待审计的断言清单（从当前代码生成，不是历史清单）
npm run audit -- --claims # 只打印断言
```

**它不运行审计。** 它打印交给审计者的简报——**因为「上下文不共享」这件事无法自动化掉**。
同一会话里派出的审计者会继承同一批假设，**而假设正是要被检验的东西**。

### 三条承重规则，每条都来自一次失败

| # | 规则 | 来源 |
|---|---|---|
| 1 | **默认推翻**——每条断言在被代码证明前都当作假 | 要求「检查」的审计者会同意；要求「推翻」的才会去看 |
| 2 | **报 0 findings 不构成证据**——必须附搜索范围与命令 | Subagent 盲信铁律：沉默与正确在报告里长得一样 |
| 3 | **finding 是输入，不是结论**——每条都要调用方用独立工具调用复核 | P-25 那次审计报了 5 条，5 条都被复核过——**但复核是调用方做的，不是审计者** |

### 调用方必须做的（顺序不能换）

1. 派审计者，**不共享上下文**
2. 收到报告后，**逐条用独立工具调用复核**——不采信它的表述
3. **它报「0 findings」时，拿它的搜索范围自己重搜一遍**
4. 有实质发现的，进缺陷编号 + 复发看板

**判据**：一次审计如果没有产生「我没想到的东西」，它要么范围太小，要么不够独立。