/**
 * 占位 Driver：该平台的依赖没装。
 *
 * 为什么不直接不注册：工作流里引用了它，注册表找不到会报「未注册的 agent」，
 * 那个错误对使用者毫无信息量。用它顶上，失败时能说清楚缺什么、怎么补。
 * 界面上也会据此把该 Agent 标成不可用。
 */

import type { AgentDriver, AgentResult, AgentTask, DriverEvent } from '../core/types';

export class UnavailableDriver implements AgentDriver {
  readonly kind: string;
  readonly capabilities = {
    streaming: false,
    structured: false as const,
    resume: false,
    tools: false,
  };

  constructor(kind: string, private readonly reason: string) {
    this.kind = kind;
  }

  async run(_task: AgentTask, _emit: (e: DriverEvent) => void): Promise<AgentResult> {
    throw new Error(this.reason);
  }
}
