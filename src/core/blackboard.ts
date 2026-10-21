/**
 * 黑板（Blackboard）。
 *
 * 这是 Agent 之间共享状态的唯一通道。刻意做成「只增不删」：
 * 节点只会写入自己的产出，不会篡改别人写过的东西，
 * 因此任意时刻的黑板快照都能解释「这个结论是怎么来的」。
 *
 * 模板语法只支持 {{a.b}} 这种路径取值，不支持表达式。
 * 需要计算就走条件分支，不要把逻辑塞进字符串里。
 */

import type { NodeOutput } from './types';

export class Blackboard {
  private readonly entries = new Map<string, NodeOutput>();
  private readonly input: Record<string, string>;

  constructor(input: Record<string, string> = {}) {
    this.input = input;
  }

  write(out: NodeOutput): void {
    this.entries.set(out.nodeId, out);
  }

  get(nodeId: string): NodeOutput | undefined {
    return this.entries.get(nodeId);
  }

  /** 只读快照，交给 Driver 时用。 */
  snapshot(): Readonly<Record<string, NodeOutput>> {
    return Object.fromEntries(this.entries);
  }

  nodeIds(): string[] {
    return [...this.entries.keys()];
  }

  /** 渲染 {{nodeId.text}} / {{nodeId.data.xxx}} / {{input.xxx}} / {{item}} */
  render(template: string, scope: { item?: unknown } = {}): string {
    return template.replace(/\{\{\s*([\p{L}\p{N}_.$]+)\s*\}\}/gu, (_m, expr: string) => {
      const v = this.resolve(expr, scope);
      return v === undefined ? '' : stringify(v);
    });
  }

  resolve(expr: string, scope: { item?: unknown } = {}): unknown {
    if (expr === 'item') return scope.item;

    const parts = expr.split('.');
    const head = parts.shift();
    if (!head) return undefined;

    if (head === 'input') {
      return this.input[parts.join('.')];
    }

    const out = this.entries.get(head);
    if (!out) return undefined;

    let cur: unknown = out;
    for (const p of parts) {
      if (cur === null || cur === undefined) return undefined;
      if (typeof cur !== 'object') return undefined;
      cur = (cur as Record<string, unknown>)[p];
    }
    return cur;
  }
}

function stringify(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
