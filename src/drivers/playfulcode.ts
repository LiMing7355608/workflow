/**
 * PlayfulCodeDriver —— 把项目1的 Agent 包装成工作流节点。
 *
 * 为什么用「库调用」而不是「子进程」？
 * PlayfulCode 已经把 Agent 循环、工具、事件流、记忆全部做成了可编程接口，
 * 子进程化只会把这套结构压扁成文本再解析回来，白白丢掉上下文与类型。
 * 反过来说，Claude Code / Codex 这类只提供 CLI 的平台才需要子进程 Driver——
 * 两者并存，正是 AgentDriver 抽象存在的理由。
 *
 * 关键点：**每个节点独立实例化一个 Agent**。
 * 这样节点之间不共享记忆，协作只能通过黑板发生，
 * 「状态管理是否合理」才是看得见、说得清的。
 */

import path from 'node:path';
import type { AgentDriver, AgentTask, AgentResult, DriverEvent } from '../core/types';
import type { PcAgentEvent, PcModule } from '../integrations/playfulcode/types';
import { loadPlayfulCode } from '../integrations/playfulcode/loader';

export interface PlayfulCodeDriverOptions {
  /** PlayfulCode 仓库根目录（含 dist/） */
  rootDir: string;
  /** 默认服务商，可被节点 config 覆盖 */
  provider?: string;
  model?: string;
  baseUrl?: string;
  /** 默认工具集：review=只读，default=含写盘 */
  tools?: 'review' | 'default';
  /** 无头模式默认关闭人工审批（危险工具改为直接拒绝） */
  requireApproval?: boolean;
}

interface NodeConfig {
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  /** none = 不挂任何工具，适合「只做归纳」的节点 */
  tools?: 'review' | 'default' | 'none';
  maxSteps?: number;
  temperature?: number;
  workdir?: string;
  requireApproval?: boolean;
}

export class PlayfulCodeDriver implements AgentDriver {
  readonly kind = 'playfulcode';
  readonly capabilities = {
    streaming: true,
    structured: 'partial' as const,
    resume: false,
    tools: true,
  };

  private readonly mod: PcModule;
  private readonly opts: PlayfulCodeDriverOptions;

  constructor(opts: PlayfulCodeDriverOptions) {
    this.opts = opts;
    this.mod = loadPlayfulCode(opts.rootDir);
    // 加载 PlayfulCode 自己的 .env（不覆盖已存在的真实环境变量）
    this.mod.loadDotEnv(path.resolve(opts.rootDir));
  }

  get version(): string {
    return this.mod.VERSION;
  }

  /** 供 CLI 预检：缺 Key 时给出可读原因。 */
  probe(nodeConfig: Record<string, unknown> = {}): { ok: boolean; provider: string; model: string; problems: string[] } {
    const cfg = this.buildConfig({} as AgentTask, nodeConfig as NodeConfig);
    const problems = this.mod.validateConfig(cfg);
    return { ok: problems.length === 0, provider: cfg.provider, model: cfg.model, problems };
  }

  async run(task: AgentTask, emit: (e: DriverEvent) => void): Promise<AgentResult> {
    const nodeCfg = (task.config ?? {}) as NodeConfig;
    const cfg = this.buildConfig(task, nodeCfg);

    const problems = this.mod.validateConfig(cfg);
    if (problems.length > 0) {
      throw new Error(`节点 ${task.nodeId} 配置不可用：${problems.join('；')}`);
    }

    const toolSet = nodeCfg.tools ?? this.opts.tools ?? 'review';
    const registry =
      toolSet === 'none'
        ? new this.mod.ToolRegistry()
        : toolSet === 'default'
          ? this.mod.createDefaultRegistry()
          : this.mod.createReviewRegistry();

    const agent = this.mod.createAgent({
      config: cfg,
      registry,
      systemPrompt: task.systemPrompt,
      onEvent: (e) => mapEvent(e, emit),
    });

    const res = await agent.run(task.prompt, {
      signal: task.signal,
      maxSteps: nodeCfg.maxSteps ?? task.maxSteps,
    });

    return {
      text: res.answer,
      steps: res.steps,
      toolsUsed: res.toolsUsed,
      usage: res.usage,
      stopReason: res.stopReason,
    };
  }

  private buildConfig(task: AgentTask, nodeCfg: NodeConfig): ReturnType<PcModule['resolveConfig']> {
    const workdir = nodeCfg.workdir ?? task.workdir;
    return this.mod.resolveConfig({
      provider: nodeCfg.provider ?? this.opts.provider,
      model: nodeCfg.model ?? this.opts.model,
      baseUrl: nodeCfg.baseUrl ?? this.opts.baseUrl,
      apiKey: nodeCfg.apiKey,
      maxSteps: nodeCfg.maxSteps ?? task.maxSteps,
      temperature: nodeCfg.temperature,
      workdir,
      workspaceRoots: workdir ? [path.resolve(workdir)] : [],
      requireApproval: nodeCfg.requireApproval ?? this.opts.requireApproval ?? false,
      logLevel: 'warn',
    });
  }
}

/** 把 PlayfulCode 的事件翻译成本项目的归一化事件。 */
function mapEvent(e: PcAgentEvent, emit: (ev: DriverEvent) => void): void {
  switch (e.type) {
    case 'assistant_text':
      if (e.content) emit({ kind: 'text', delta: e.content });
      break;
    case 'tool_call':
      emit({ kind: 'tool_start', id: e.id, name: e.name, args: e.args });
      break;
    case 'tool_result':
      emit({ kind: 'tool_end', id: e.id, name: e.name, ok: e.ok, ms: e.ms });
      break;
    case 'tool_denied':
      emit({ kind: 'note', level: 'warn', message: `工具 ${e.name} 被拒绝：${e.reason}` });
      break;
    case 'usage':
      emit({
        kind: 'usage',
        usage: {
          promptTokens: e.promptTokens ?? 0,
          completionTokens: e.completionTokens ?? 0,
          totalTokens: e.totalTokens ?? 0,
        },
      });
      break;
    case 'retry':
      emit({ kind: 'note', level: 'warn', message: `第 ${e.attempt} 次重试（${e.delayMs}ms）：${e.reason}` });
      break;
    case 'warning':
      emit({ kind: 'note', level: 'warn', message: e.message });
      break;
    case 'error':
      emit({ kind: 'note', level: 'error', message: e.message });
      break;
    default:
      // thinking / run_start / run_end 不往上抛，引擎自己有生命周期事件
      break;
  }
}

