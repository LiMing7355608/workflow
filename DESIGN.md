# 设计文档：多 Agent 协作工作流

## 1. 要解决的问题

让多个 Agent 串成一条可运行的流水线，并且回答三个问题：

1. **它们怎么交换信息？** —— 黑板（共享状态），而不是把上一步的文本拼成 prompt 传下去。
2. **一个 Agent 挂了会怎样？** —— 下游跳过、整体标记失败，而不是跑出一份看起来正常但缺了半截的报告。
3. **接入一个新平台要改多少？** —— 一个文件 + 一行注册，引擎零改动。

## 2. 架构

```
┌──────────────────────────────────────────────────────────┐
│  工作流定义（JSON）  nodes[] + dependsOn + when + forEach   │
└───────────────────────────┬──────────────────────────────┘
                            ▼
┌──────────────────────────────────────────────────────────┐
│  引擎 engine.ts                                            │
│  DAG 调度 · 条件分支 · 循环 · 重试 · 失败传播 · 用量归并    │
└───────┬──────────────────────────────────┬───────────────┘
        │ 读/写                             │ 归一化事件
        ▼                                   ▼
┌──────────────────┐            ┌──────────────────────────┐
│  黑板             │            │  追踪 trace.ts            │
│  NodeOutput 只增  │            │  trace.jsonl + 控制台     │
│  模板 {{a.text}}  │            └──────────────────────────┘
└────────▲─────────┘
         │ AgentTask.context
┌────────┴──────────────────────────────────────────────────┐
│  AgentDriver 接口（唯一抽象）                              │
├───────────────┬────────────────┬──────────────────────────┤
│ PlayfulCode   │ fn:scan        │ Mock / 未来的 Claude CLI  │
│ （库调用）     │ （确定性函数）  │ Codex CLI / DeepSeek      │
└───────────────┴────────────────┴──────────────────────────┘
```

四层职责单一：**定义**只描述「谁依赖谁」，**引擎**只调度，**黑板**只存数据，**Driver** 只负责把某个平台跑起来。

## 3. 关键决策与取舍

### 3.1 黑板 vs 消息队列

| 方案 | 结论 |
|---|---|
| 消息队列（每个 Agent 收 inbox） | 适合分布式，但要处理投递语义、顺序、重复消费，MVP 阶段是负担 |
| **黑板（共享只增状态）** | **采用**。节点只写自己的槽位，下游按名字读，天然幂等、天然可回放 |

只增不删有个实际好处：任意时刻的黑板快照，都能完整解释「这份报告是怎么推出来的」。`runs/<runId>/outputs.md` 就是它的落地形态。

### 3.2 dependsOn（DAG） vs 顺序数组

顺序数组最简单，但拿不到并行；一旦流程变成「扫描 → 质量/安全并行 → 汇总」，就只能靠框架外的 `Promise.all` 硬编码，流程就不可序列化了。

DAG 的代价是多一层拓扑调度，收益是**并行免费**：`quality` 和 `security` 之间不写任何并发代码，引擎发现二者依赖都已完成，同一批就一起跑了。测试 `并行：无依赖的节点同时可跑` 断言峰值并发为 3。

### 3.3 条件为什么不用表达式求值

`when: { path, op, value }` 是结构化条件，不是 `eval("a.count > 0")`。

- 工作流 JSON 可能来自用户或可视化界面，`eval` 等于把代码执行权交出去；
- 结构化条件可以被 `validate` 静态检查，也能直接渲染成 GUI 表单；
- 需要复杂判断时，正确做法是新增一个 `fn:` 节点，而不是把逻辑塞进字符串。

### 3.4 PlayfulCode 用库调用，不用子进程

PlayfulCode 已经暴露了 `createAgent / ToolRegistry / AgentEvent`。子进程化会把这套结构压扁成文本再解析回来，丢掉类型、事件和上下文。

**反过来，这恰恰说明了 Driver 抽象的必要性**：Claude Code、Codex 这类只提供 CLI 的平台没有可编程接口，必须子进程 + JSONL 解析。两种形态共存，引擎不需要知道区别。

### 3.5 每个节点独立 Agent 实例

`PlayfulCodeDriver` 每次 `run()` 都新建 `CodeReviewAgent`。这意味着：

- 节点之间**不共享记忆**，协作只能通过黑板发生 —— 数据流是显式、可审计的；
- 同一个工作流里可以让不同节点用不同的 provider/model（`config.provider`），互不干扰。

代价是每次都要重新组装配置，实测开销可忽略（毫秒级）。

## 4. Agent 间通信

**数据通道**：黑板 + 模板。

```jsonc
{ "id": "report", "dependsOn": ["quality", "security"],
  "prompt": "## 质量\n{{quality.text}}\n\n## 安全\n{{security.text}}" }
```

模板只支持路径取值（`{{a.b.c}}`），不支持表达式和函数调用。这是刻意的限制：模板一旦能计算，工作流 JSON 就变成了半门编程语言，校验和可视化都会失效。

**拓扑通道**：`consumes`。引擎从模板里反推出「这个节点读了哪些上游」，写进 `node_start` 事件。控制台里 `⚙ report [playfulcode] ← scan, quality, security` 就是这么来的，也是「谁依赖谁」的实际证据，而不只是声明。

## 5. 流程控制

| 能力 | 实现 |
|---|---|
| 顺序 | 隐式：B 依赖 A，A 完成后 B 就绪 |
| 并行 | 隐式：同一批就绪节点并发执行，受 `--concurrency` 限制 |
| 条件分支 | `when`，不满足则记 `skipped`，下游照常推进 |
| 循环 | `forEach`，对数组逐项执行，`max` 封顶防止爆炸 |
| 重试 | `retry.attempts` + `delayMs` + `backoff` |

**跳过 ≠ 失败**。条件不满足的下游仍然会跑（它在等的是「上游结束」，不是「上游成功」）；上游**失败**时下游才是 `skipped` 且整体 `failed`。这两种 `skipped` 在 `NodeOutput.text` 里会写明原因，不会混淆。

## 6. 错误处理

三层：

1. **编排期**：`validate` 检查重复 id、悬空依赖、环、非法字符。非法字符不只是洁癖 —— id 会被写进终端和 `runs/<runId>/` 路径。
2. **节点级**：`retry` 按策略重试；最终失败产出 `status: 'failed'` 的 `NodeOutput`（**失败也要留记录**，否则「谁失败了」无从查起）。
3. **流程级**：任一节点失败，下游全部跳过，整体标记 `failed`，退出码 1。


## 7. 可扩展性

### 新增平台的实际成本

| 平台 | 接入方式 |
|---|---|
| PlayfulCode | 库调用 |
| 确定性函数 | 直接实现 |
| Claude Code | `-p --output-format stream-json`，prompt 走 stdin |
| DeepSeek Harness (`dsh`) | `--profile headless --json`，任务走 stdin |
| Codex CLI | `exec --json`（thread/turn/item 事件） |
| OpenCode | `run --format json`（NDJSON） |
| Qoder CLI | `-p --output-format stream-json`（刻意对齐 Claude） |
| WorkBuddy | `codebuddy -p --output-format json` |
| Z Code | `--prompt … --json` |
| Trae | `trae-cli run "<task>"` |

### 声明式 CLI 适配

外部平台的差异只有三件事：**可执行文件叫什么、参数怎么拼、输出怎么解析**。所以做成一份配置而不是一个类：

```ts
interface CliAgentSpec {
  kind: string;
  bin: string;
  args: string[];                        // 含 {prompt} {workdir} {model} 占位符
  stdin?: boolean;                       // prompt 走 stdin
  parser: 'claude-stream-json' | 'codex-json' | 'opencode-json' | 'dsh-json' | 'json-result' | 'plain';
  capabilities: AgentCapabilities;
  source?: string;                       // 参数出处，换版本后据此复核
}
```

一个 `CliAgentDriver` 吃下所有平台，加新平台 = 在 `presets.ts` 加一条。只有当输出格式与现有五种解析器都不同时，才需要写新解析器。

**版本漂移是常态，所以解析器要兼容而不是严格。** Codex CLI 的 `--json` 事件结构在 2025 年整体换过一次：从 `{"id","msg":{"type":"agent_message"}}` 变成 `thread.started` / `turn.completed` / `item.completed`。照旧文档写解析器，装上新版会**静默解析出空文本**。所以 `codex-json` 同时兼容新旧两套结构——多写 20 行，换来的是一年内不会因为版本升级而挂掉。

每个 spec 都带 `source` 字段记录参数出处（官方文档地址或本地源码路径）。换版本后先 `workflow probe <kind>` 看 `--help`，对着改 spec，不用碰引擎和解析器。

### 为什么 prompt 走 stdin 而不是命令行参数

Windows 上 npm 安装的 CLI 是 `.cmd` 包装，必须经过 shell 才能启动；而 `spawn(bin, args, { shell: true })` 的行为是「拼接而非转义」，Node 为此专门发了弃用警告（DEP0190）。只要 prompt 里有引号、`&`、`|`，就会被 shell 重新解释。

所以参数模板里只放静态开关，prompt 一律走 stdin。这不仅解决了注入，还顺便让超长 prompt 不受命令行长度限制。

### 能力声明的实际用途

```ts
capabilities = { streaming: true, structured: 'partial', resume: false, tools: true }
```

这不是文档摆设。各平台确实不同：Claude 有 `--json-schema` 能保证结构化输出，Codex 没有。DeepSeek Harness 的会话是持久化的，续跑靠 `--session-id`；而「DeepSeek 模型 API 本身无状态」说的是另一层，别把两者混为一谈——我们接的是 Harness，不是裸 API。有了声明，工作流可以在**编排期**发现「这个节点要求结构化输出，但选的 Driver 不支持」，而不是跑到一半才崩。

界面上这些能力直接渲染成标签，「未安装」也是标签——用户选 Agent 时看到的就是它真实的状态。

## 8. 与项目 1 的复用

复用的是**能力**，不是代码拷贝：

| PlayfulCode 提供的 | 在工作流里的角色 |
|---|---|
| Agent 循环（THINK → ACT → ANSWER） | 节点内部的执行体 |
| 工具注册表与最小权限（review / default / none） | 节点级权限边界 |
| `AgentEvent` 事件流 | 映射成归一化事件，驱动追踪 |
| 静态分析规则引擎 | `fn:scan` 节点（未配置时退回内置扫描器，见 `fallback-scan.ts`） |
| Provider 预设 | 节点级模型选择 |
| `.env` 与配置解析 | `doctor` 的预检依据 |

接入方式刻意做成**接口收窄**（`src/integrations/playfulcode/types.ts` 只声明用到的 12 个导出）。上游改了签名，这里编译期就报错；而不是运行时 `undefined is not a function`。

真正的缺口是 PlayfulCode 的 `tsconfig` 里 `declaration: false`，没有 `.d.ts`。长期方案是给它打开 `declaration`，本项目直接消费其类型；当前用声明文件是过渡手段。

### 可选依赖的边界

PlayfulCode 是可选依赖，不是运行时前提。没有它时：`playfulcode` 节点由占位 Driver 接管，失败信息直接告诉使用者缺什么、可以换成哪个 Agent；`fn:scan` 退回内置的 6 条规则扫描器。这样评审者只装 Node 也能看到完整流水线跑通，而不是卡在第一步。

代价是两套扫描规则并存，结论不完全一致。这是刻意接受的——内置扫描器的定位是「保证流程能跑」，不是「替代项目一」。

## 9. 安全边界

这次真实运行产出的报告里，安全审查节点自己指出了本项目的一处高危：

> `integrations/playfulcode/loader.ts` 里 `require(entry)` 的路径由 `--pc-root` / `PC_ROOT` 派生，无完整性校验，等于以宿主进程权限执行该目录下的任意 JS。

这个判断是对的。当前的处理是：**文档里明确写「只指向可信仓库」**，并已修复同批报告中另外两条：

- 终端转义注入：`nodeId / agent / message` 来自工作流 JSON 与模型输出，打到终端前剥掉 C0 控制字符（否则 `\x1b]52` 可以改写剪贴板、伪造「校验通过」）；
- 节点 id 字符白名单：它会被拼进 `runs/<runId>/` 路径。

尚未做的是 `--pc-root` 的前缀校验。它需要先定义「允许的根目录」从哪来 —— 这是产品决策，不是技术决策，所以留到下一版而不是现在拍脑袋加。

## 10. 可视化编排

### 为什么是「零依赖 SVG」而不是 React Flow

React Flow 开箱即用，但会把项目从「`tsc` 一把梭」变成需要打包工具，交作业的体积和构建复杂度都上一个台阶。而这个编辑器的核心交互只有三件事：拖节点、拉贝塞尔连线、点选改属性——原生 SVG 完全够用，约 600 行 JS。

### 结构

```
浏览器                                          Node 进程
┌────────────────────────┐   GET /api/workflows   ┌────────────┐
│ app.js                 │ ─────────────────────► │            │
│  · SVG 画布 / 拖拽      │   PUT /api/workflow    │ web/server │
│  · 属性面板             │ ─────────────────────► │            │
│  · 状态着色             │                        └─────┬──────┘
└───────────▲────────────┘                              │ runWorkflow
            │  SSE  /api/events?session=…               │
            └───────────────────────────────────────────┘
```

关键取舍：**服务端不实现任何编排逻辑**，`/api/run` 只是把 spec 转交给 `runWorkflow`，再把它发出的事件原样推给浏览器。编辑器和服务端都不需要知道「黑板上有什么」，它们只消费 `WorkflowEvent`。

### 编辑器改了什么、没改什么

- **改了** `NodeSpec`，加了一个 `ui: {x, y}` 字段。**引擎完全不读它**——位置是纯展示信息，不该污染执行语义。
- **没改** 引擎、黑板、Driver 任何一行。这是前面抽象是否成立的实证：加一个完整的图形化前端，运行时一行没动。

### 前端侧的校验

编辑器在连线时会自己查环（`createsCycle`），拒绝建立会成环的依赖；真正保存时服务端还会用 `validateSpec` 再查一遍。前端校验是体验，后端校验才是保证。

### SSE 而不是轮询

工作流是几十秒到几分钟的长任务，节点状态变化不均匀。轮询要么浪费请求，要么延迟明显；SSE 单向推送正好匹配。服务端会缓存已发生的事件，浏览器晚到也能重放，不会出现「页面打开了但前几个节点没点亮」。

