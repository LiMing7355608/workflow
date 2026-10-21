/**
 * 外部 CLI Agent 的声明式适配。
 *
 * 接一个平台不需要写代码，只需要一份 spec：
 * 可执行文件叫什么、参数怎么拼、输出怎么解析。
 * 这样「没装 CLI 的平台」也能先把适配写出来，装好即可用。
 */

import type { AgentCapabilities, DriverEvent, Usage } from '../../core/types';

export type ParserId =
  | 'claude-stream-json'
  | 'codex-json'
  | 'opencode-json'
  | 'dsh-json'
  | 'json-result'
  | 'plain';

export interface CliAgentSpec {
  /** 工作流 JSON 里 `"agent": "<kind>"` 用的名字 */
  kind: string;
  /** 界面上的显示名 */
  label: string;
  /** 可执行文件名 */
  bin: string;
  /**
   * 参数模板。占位符：
   *   {prompt}   提示词（仅当 stdin=false 时使用）
   *   {model}    节点 config.model
   *   {session}  续跑用的会话 id
   *   {workdir}  节点工作目录（多数 CLI 用 cwd 就够，少数需要显式参数）
   */
  args: string[];
  /** 从 stdin 读提示词（更安全：避免 Windows 上 shell 转义问题） */
  stdin?: boolean;
  parser: ParserId;
  /** 指定模型时追加的参数，如 ["--model", "{model}"] */
  modelArgs?: string[];
  /** 允许工具的参数，如 ["--allowedTools", "{allowed}"] */
  capabilities: AgentCapabilities;
  /** 是否在本机实测过。false = 参数按官方文档写的，未验证 */
  verified: boolean;
  /** 给使用者的提示：参数不确定时怎么办 */
  note?: string;
  /** 参数来源（官方文档地址），便于换版本后核对 */
  source?: string;
  /** 追加的环境变量 */
  env?: Record<string, string>;
  /** 默认超时 */
  timeoutMs?: number;
}

/** 单行解析器的累加状态。 */
export interface ParseState {
  /** 流式增量文本 */
  chunks: string[];
  /** 权威的最终答案（很多 CLI 会单独给一份） */
  finalText?: string;
  usage: Usage;
  toolsUsed: string[];
  sessionId?: string;
  stopReason?: string;
  error?: string;
}

export type LineParser = (
  line: string,
  state: ParseState,
  emit: (e: DriverEvent) => void,
) => void;

export function emptyState(): ParseState {
  return {
    chunks: [],
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    toolsUsed: [],
  };
}
