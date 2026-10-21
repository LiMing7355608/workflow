/**
 * PlayfulCode 对外契约的类型子集。
 *
 * 为什么手写而不是直接 import？
 * PlayfulCode 的 tsconfig 里 declaration: false，dist 下没有 .d.ts，
 * 所以必须自己声明我们用到的部分。
 *
 * 这是**有意的接口收窄**：这里列出来的就是本项目对 PlayfulCode 的全部依赖面。
 * 一旦上游改了这些签名，这里会编译报错，而不会等到运行时才炸。
 * 长期方案是给 PlayfulCode 打开 declaration 直接消费其类型。
 */

/* ----------------------------- 消息 ----------------------------- */

export interface PcToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface PcChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: PcToolCall[];
}

/* ----------------------------- 事件 ----------------------------- */

export type PcAgentEvent =
  | { type: 'run_start'; runId: string; task: string; provider: string; model: string }
  | { type: 'thinking'; step: number; note: string }
  | { type: 'assistant_text'; step: number; content: string }
  | { type: 'tool_call'; step: number; id: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; step: number; id: string; name: string; ok: boolean; content: string; ms: number }
  | { type: 'tool_denied'; step: number; id: string; name: string; reason: string }
  | { type: 'retry'; attempt: number; delayMs: number; reason: string }
  | { type: 'usage'; promptTokens?: number; completionTokens?: number; totalTokens?: number }
  | { type: 'warning'; message: string }
  | { type: 'error'; message: string; recoverable: boolean }
  | { type: 'run_end'; runId: string; steps: number; ms: number; answer: string; stopReason: string };

/* ----------------------------- 配置 ----------------------------- */

export interface PcConfigOverrides {
  provider?: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  temperature?: number;
  maxSteps?: number;
  requireApproval?: boolean;
  workdir?: string;
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
  workspaceRoots?: string[];
  forceTextProtocol?: boolean;
}

export interface PcAppConfig extends PcConfigOverrides {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  workdir: string;
  maxSteps: number;
  requireApproval: boolean;
  workspaceRoots: string[];
}

/* ----------------------------- 工具 ----------------------------- */

export interface PcToolRegistry {
  names(): string[];
  size(): number;
}

export interface PcToolRegistryCtor {
  new (initial?: unknown[]): PcToolRegistry;
}

/* ----------------------------- Agent ----------------------------- */

export interface PcRunResult {
  runId: string;
  answer: string;
  steps: number;
  ms: number;
  stopReason: string;
  toolsUsed: string[];
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
}

export interface PcAgent {
  run(task: string, opts?: { maxSteps?: number; signal?: AbortSignal; remember?: boolean }): Promise<PcRunResult>;
  listTools(): string[];
  history(): PcChatMessage[];
  importHistory(messages: PcChatMessage[]): void;
}

export interface PcAgentOptions {
  config: PcAppConfig;
  registry: PcToolRegistry;
  systemPrompt?: string;
  onEvent?: (e: PcAgentEvent) => void;
  onApproval?: (req: unknown) => Promise<unknown>;
}

/* ----------------------------- 静态分析 ----------------------------- */

export interface PcFinding {
  ruleId: string;
  title: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  file: string;
  line: number;
  column: number;
  snippet: string;
  message: string;
  suggestion: string;
}

export interface PcScanReport {
  files: string[];
  findings: PcFinding[];
  stats: {
    files: number;
    lines: number;
    bySeverity: Record<'critical' | 'high' | 'medium' | 'low', number>;
  };
  ms: number;
}

/* ----------------------------- 模块入口 ----------------------------- */

/** PlayfulCode `dist/index.js` 中本项目的依赖面。 */
export interface PcModule {
  createAgent(opts: PcAgentOptions): PcAgent;
  createDefaultRegistry(): PcToolRegistry;
  createReviewRegistry(): PcToolRegistry;
  ToolRegistry: PcToolRegistryCtor;
  resolveConfig(overrides?: PcConfigOverrides): PcAppConfig;
  loadDotEnv(dir: string, filename?: string): number;
  validateConfig(cfg: PcAppConfig): string[];
  maskSecret(secret: string): string;
  scanPath(opts: { target: string; workdir: string; maxFiles?: number }): PcScanReport;
  renderReportText(report: PcScanReport): string;
  sortBySeverity(findings: PcFinding[]): PcFinding[];
  VERSION: string;
}
