/**
 * MockDriver —— 不碰网络的确定性 Agent。
 *
 * 存在的意义不是「省 API 费用」，而是让工作流本身可以离线测试：
 * 引擎、黑板、条件分支、重试这些逻辑的正确性，不应该依赖模型今天心情好不好。
 * 用法：`workflow run --mock`，全部 LLM 节点替换成回显。
 */

import type { AgentDriver, AgentResult, AgentTask, DriverEvent, Usage } from '../core/types';

export class MockDriver implements AgentDriver {
  readonly kind: string;

  /** kind 可覆盖，便于在离线模式下顶替某个具体平台的同名 Driver */
  constructor(kind = 'mock') {
    this.kind = kind;
  }
  readonly capabilities = {
    streaming: true,
    structured: true,
    resume: false,
    tools: false,
  };

  async run(task: AgentTask, emit: (e: DriverEvent) => void): Promise<AgentResult> {
    const usage: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    emit({ kind: 'note', level: 'info', message: `mock 节点 ${task.nodeId}（${task.prompt.length} 字符输入）` });

    const text = `[mock:${task.nodeId}] 收到任务：${truncate(task.prompt, 120)}`;
    emit({ kind: 'text', delta: text });
    emit({ kind: 'usage', usage });

    return { text, steps: 1, toolsUsed: [], usage };
  }
}

function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length <= n ? flat : `${flat.slice(0, n)}…`;
}

/**
 * 让某个 Driver 在失败时也可用，并能模拟「不稳定节点」以便演示重试。
 * 仅在 --mock 下用于压力测试引擎行为。
 */
export class FlakyDriver extends MockDriver {
  override readonly kind = 'flaky';
  private calls = 0;

  constructor(private readonly failTimes: number) {
    super('flaky');
  }

  override async run(task: AgentTask, emit: (e: DriverEvent) => void): Promise<AgentResult> {
    this.calls += 1;
    if (this.calls <= this.failTimes) {
      throw new Error(`模拟第 ${this.calls} 次失败`);
    }
    return super.run(task, emit);
  }
}
