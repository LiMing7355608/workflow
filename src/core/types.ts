/**
 * 全局类型契约。
 *
 * 设计原则：**工作流引擎只认识这一层**。
 * 不管是 PlayfulCode 内置 Agent、Claude Code CLI、还是本地确定性函数，
 * 对引擎而言都只是一个实现了 AgentDriver 的节点。
 * 新增平台 = 新增一个 Driver 文件，引擎零改动。
 */

/* ------------------------------------------------------------------ *
 * 用量与结果
 * ------------------------------------------------------------------ */

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export const ZERO_USAGE: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

export type NodeStatus = 'ok' | 'skipped' | 'failed';

/** 一个节点跑完之后写进黑板的东西。下游节点通过模板读取。 */
export interface NodeOutput {
  nodeId: string;
  agent: string;
  text: string;
  steps: number;
  toolsUsed: string[];
  usage: Usage;
  ms: number;
  status: NodeStatus;
  /** Driver 上报的终止原因，便于事后判断输出质量 */
  stopReason?: string;
  /** driver 任意附加的结构化数据（如静态扫描的 findings） */
  data?: unknown;
}

/* ------------------------------------------------------------------ *
 * Driver 契约
 * ------------------------------------------------------------------ */

/** Driver 自报的能力。引擎据此做「编排期检查」，而不是运行到一半才炸。 */
export interface AgentCapabilities {
  /** 是否支持逐段文本增量 */
  streaming: boolean;
  /** 是否能保证结构化输出：true=原生 schema，'partial'=靠提示词约定，false=不支持 */
  structured: boolean | 'partial';
  /** 是否支持跨次会话续跑（否则重试只能重放全部上下文） */
  resume: boolean;
  /** 是否能调用工具（决定它算不算真正的 Agent） */
  tools: boolean;
}

/** Driver 往引擎抛的归一化事件。注意：不是各家原始格式。 */
export type DriverEvent =
  | { kind: 'text'; delta: string }
  | { kind: 'tool_start'; id: string; name: string; args: Record<string, unknown> }
  | { kind: 'tool_end'; id: string; name: string; ok: boolean; ms: number }
  | { kind: 'usage'; usage: Usage }
  | { kind: 'note'; level: 'info' | 'warn' | 'error'; message: string };

export interface AgentTask {
  nodeId: string;
  /** 已经渲染过模板的最终提示词 */
  prompt: string;
  systemPrompt?: string;
  /** 已完成节点的输出快照（只读） */
  context: Readonly<Record<string, NodeOutput>>;
  /** 该节点被授权操作的目录 */
  workdir: string;
  maxSteps?: number;
  /** NodeSpec.config 原样透传，供 Driver 自行解释 */
  config?: Record<string, unknown>;
  signal: AbortSignal;
}

export interface AgentResult {
  text: string;
  steps: number;
  toolsUsed: string[];
  usage: Usage;
  /** Driver 上报的终止原因；'max_steps' 意味着答案可能是半成品 */
  stopReason?: string;
  data?: unknown;
}

export interface AgentDriver {
  readonly kind: string;
  readonly capabilities: AgentCapabilities;
  run(task: AgentTask, emit: (e: DriverEvent) => void): Promise<AgentResult>;
}

/* ------------------------------------------------------------------ *
 * 工作流定义（可序列化，能被 JSON 表达）
 * ------------------------------------------------------------------ */

/**
 * 条件分支用结构化描述而不是 eval：
 *   { path: "scan.severity.critical", op: "gt", value: 0 }
 * 好处是零注入风险、可静态校验、能被 GUI 直接渲染成表单。
 */
export interface Condition {
  path: string;
  op: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'exists' | 'empty';
  value?: unknown;
}

export interface ForEach {
  /** 指向一个数组的路径，如 "scan.findings" */
  over: string;
  /** 模板里用 {{item}} 引用当前元素 */
  as?: string;
  /** 上限，防止一次跑出几百次调用 */
  max?: number;
}

export interface RetryPolicy {
  attempts: number;
  delayMs: number;
  /** 每次重试延迟翻倍 */
  backoff?: boolean;
}

export interface NodeSpec {
  id: string;
  /** driver kind，如 "playfulcode" / "fn:scan" / "mock" */
  agent: string;
  dependsOn?: string[];
  /** 支持 {{nodeId.text}} / {{input.xxx}} / {{item}} 模板 */
  prompt?: string;
  systemPrompt?: string;
  when?: Condition;
  forEach?: ForEach;
  retry?: RetryPolicy;
  maxSteps?: number;
  /** driver 私有配置，原样透传 */
  config?: Record<string, unknown>;
  /** 可视化编辑器使用的画布坐标；引擎完全忽略这个字段 */
  ui?: { x: number; y: number };
}

export interface WorkflowSpec {
  name: string;
  description?: string;
  /** 所有节点的默认工作目录，可被节点 config.workdir 覆盖 */
  workdir?: string;
  /** 工作流级默认值，节点同名配置优先 */
  defaults?: {
    config?: Record<string, unknown>;
    retry?: RetryPolicy;
    maxSteps?: number;
  };
  input?: Record<string, string>;
  nodes: NodeSpec[];
}

/* ------------------------------------------------------------------ *
 * 可观测事件（写 trace.jsonl，也用于控制台渲染）
 * ------------------------------------------------------------------ */

export type WorkflowEvent =
  | { type: 'workflow_start'; runId: string; name: string; nodes: number; at: number }
  | {
      type: 'node_start';
      runId: string;
      nodeId: string;
      agent: string;
      attempt: number;
      /** 该节点从黑板读了哪些上游（由模板自动推导） */
      consumes: string[];
      at: number;
    }
  | { type: 'node_text'; nodeId: string; delta: string; at: number }
  | { type: 'node_tool'; nodeId: string; phase: 'start' | 'end'; name: string; ok?: boolean; ms?: number; at: number }
  | { type: 'node_note'; nodeId: string; level: string; message: string; at: number }
  | { type: 'node_retry'; nodeId: string; attempt: number; delayMs: number; reason: string; at: number }
  | { type: 'node_skip'; nodeId: string; reason: string; at: number }
  | { type: 'node_end'; nodeId: string; status: NodeStatus; ms: number; chars: number; at: number }
  | { type: 'workflow_end'; runId: string; status: NodeStatus; ms: number; at: number };
