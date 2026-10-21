/**
 * 工作流引擎。
 *
 * 模型是「黑板 + DAG」：
 *   - 每个节点只声明依赖（dependsOn），不声明执行顺序；
 *   - 依赖全部完成的节点同时可跑，天然获得并行；
 *   - 节点产出写进黑板，下游用 {{nodeId.text}} 读，这就是 Agent 间的消息传递。
 *
 * 刻意没有做的事：不做分布式调度、不做持久化快照、不做动态改图。
 * MVP 的边界越清楚，后面加东西越容易。
 */

import { Blackboard } from './blackboard';
import type {
  AgentDriver,
  Condition,
  NodeOutput,
  NodeSpec,
  NodeStatus,
  Usage,
  WorkflowEvent,
  WorkflowSpec,
} from './types';
import { ZERO_USAGE } from './types';

export interface EngineOptions {
  drivers: Record<string, AgentDriver>;
  /** 默认工作目录 */
  workdir: string;
  emit?: (e: WorkflowEvent) => void;
  /** 同时可跑的节点数，默认 4 */
  concurrency?: number;
  signal?: AbortSignal;
}

export interface RunSummary {
  runId: string;
  status: NodeStatus;
  ms: number;
  outputs: Record<string, NodeOutput>;
  usage: Usage;
  blackboard: Blackboard;
}

export function validateSpec(spec: WorkflowSpec): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();

  for (const n of spec.nodes) {
    if (ids.has(n.id)) problems.push(`节点 id 重复：${n.id}`);
    // id 会被写进终端与 runs/<runId>/ 路径，限定字符集是最省事的防御
    if (!/^[A-Za-z0-9_-]+$/.test(n.id)) {
      problems.push(`节点 id 只允许字母、数字、下划线、连字符：${JSON.stringify(n.id)}`);
    }
    ids.add(n.id);
  }

  for (const n of spec.nodes) {
    for (const dep of n.dependsOn ?? []) {
      if (!ids.has(dep)) problems.push(`节点 ${n.id} 依赖了不存在的节点 ${dep}`);
    }
  }

  // 环检测
  const state = new Map<string, 0 | 1 | 2>();
  const visit = (id: string, trail: string[]): void => {
    const s = state.get(id) ?? 0;
    if (s === 2) return;
    if (s === 1) {
      problems.push(`检测到环：${[...trail, id].join(' → ')}`);
      return;
    }
    state.set(id, 1);
    const node = spec.nodes.find((n) => n.id === id);
    for (const dep of node?.dependsOn ?? []) visit(dep, [...trail, id]);
    state.set(id, 2);
  };
  for (const n of spec.nodes) visit(n.id, []);

  return problems;
}

export async function runWorkflow(rawSpec: WorkflowSpec, opts: EngineOptions): Promise<RunSummary> {
  const spec = applyDefaults(rawSpec);
  const started = Date.now();
  const runId = makeRunId();
  const emit = opts.emit ?? (() => {});
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const board = new Blackboard(spec.input ?? {});
  const defaultWorkdir = spec.workdir ?? opts.workdir;

  const problems = validateSpec(spec);
  if (problems.length > 0) throw new Error(`工作流定义有误：\n- ${problems.join('\n- ')}`);

  emit({ type: 'workflow_start', runId, name: spec.name, nodes: spec.nodes.length, at: Date.now() });

  const done = new Set<string>();
  const failed = new Set<string>();
  const running = new Set<string>();
  let overall: NodeStatus = 'ok';

  const canRun = (n: NodeSpec): boolean => {
    if (done.has(n.id) || failed.has(n.id) || running.has(n.id)) return false;
    return (n.dependsOn ?? []).every((d) => done.has(d) || failed.has(d));
  };

  const blockedByFailure = (n: NodeSpec): string | undefined =>
    (n.dependsOn ?? []).find((d) => failed.has(d));

  while (done.size + failed.size < spec.nodes.length) {
    if (opts.signal?.aborted) {
      overall = 'failed';
      break;
    }

    const ready = spec.nodes.filter(canRun);

    // 依赖已失败 / 条件不满足之外的死锁（理论上被环检测拦住了，这里兜底）
    if (ready.length === 0) {
      const stuck = spec.nodes.filter((n) => !done.has(n.id) && !failed.has(n.id));
      if (stuck.length > 0) {
        for (const n of stuck) {
          failed.add(n.id);
          emit({ type: 'node_skip', nodeId: n.id, reason: '无可执行状态（死锁）', at: Date.now() });
        }
        overall = 'failed';
      }
      break;
    }

    const batch = ready.slice(0, concurrency);
    await Promise.all(
      batch.map(async (node) => {
        running.add(node.id);
        try {
          const upstreamFailure = blockedByFailure(node);
          if (upstreamFailure) {
            failed.add(node.id);
            const reason = `上游节点 ${upstreamFailure} 失败`;
            emit({ type: 'node_skip', nodeId: node.id, reason, at: Date.now() });
            board.write(skipOutput(node, reason));
            return;
          }
          const out = await runNode(node, { ...opts, runId, emit, board, workdir: defaultWorkdir });
          if (out.status === 'failed') failed.add(node.id);
          else done.add(node.id);
          board.write(out);
        } catch (err) {
          failed.add(node.id);
          emit({
            type: 'node_note',
            nodeId: node.id,
            level: 'error',
            message: (err as Error).message,
            at: Date.now(),
          });
          // 失败也要留下记录：没有 NodeOutput 的黑板会让「谁失败了」无从查起
          board.write(failureOutput(node, (err as Error).message));
        } finally {
          running.delete(node.id);
        }
      }),
    );

    if (running.size !== 0) throw new Error('调度器不变量被破坏：批次结束后仍有节点在运行');
  }

  const ms = Date.now() - started;
  if (failed.size > 0) overall = 'failed';

  const outputs = board.snapshot() as Record<string, NodeOutput>;
  const usage = Object.values(outputs).reduce<Usage>(
    (acc, o) => ({
      promptTokens: acc.promptTokens + o.usage.promptTokens,
      completionTokens: acc.completionTokens + o.usage.completionTokens,
      totalTokens: acc.totalTokens + o.usage.totalTokens,
    }),
    { ...ZERO_USAGE },
  );

  emit({ type: 'workflow_end', runId, status: overall, ms, at: Date.now() });
  return { runId, status: overall, ms, outputs, usage, blackboard: board };
}

/* ------------------------------------------------------------------ *
 * 单节点执行
 * ------------------------------------------------------------------ */

interface NodeRunCtx extends EngineOptions {
  runId: string;
  emit: (e: WorkflowEvent) => void;
  board: Blackboard;
  workdir: string;
}

async function runNode(node: NodeSpec, ctx: NodeRunCtx): Promise<NodeOutput> {
  const { emit, board } = ctx;

  // 1. 条件分支
  if (node.when && !evaluate(node.when, board)) {
    const reason = `条件不满足：${node.when.path} ${node.when.op} ${JSON.stringify(node.when.value ?? '')}`;
    emit({ type: 'node_skip', nodeId: node.id, reason, at: Date.now() });
    return skipOutput(node, reason);
  }

  const driver = ctx.drivers[node.agent];
  if (!driver) throw new Error(`节点 ${node.id} 使用了未注册的 agent：${node.agent}`);

  // 2. 循环：对数组逐项执行，产出合并
  if (node.forEach) {
    return runForEach(node, driver, ctx);
  }

  return runOnce(node, driver, ctx);
}

async function runOnce(
  node: NodeSpec,
  driver: AgentDriver,
  ctx: NodeRunCtx,
  scope: { item?: unknown } = {},
): Promise<NodeOutput> {
  const { emit, board } = ctx;
  const prompt = withItem(board.render(node.prompt ?? '', scope), scope);
  const systemPrompt = node.systemPrompt ? board.render(node.systemPrompt, scope) : undefined;
  const consumes = collectRefs(node.prompt ?? '');
  const retry = node.retry ?? { attempts: 1, delayMs: 0 };

  let lastErr: Error | undefined;

  for (let attempt = 1; attempt <= Math.max(1, retry.attempts); attempt++) {
    const startedAt = Date.now();
    emit({
      type: 'node_start',
      runId: ctx.runId,
      nodeId: node.id,
      agent: node.agent,
      attempt,
      consumes,
      at: startedAt,
    });

    const usage: Usage = { ...ZERO_USAGE };
    try {
      const result = await driver.run(
        {
          nodeId: node.id,
          prompt,
          systemPrompt,
          context: board.snapshot(),
          workdir: nodeWorkdir(node, ctx),
          maxSteps: node.maxSteps,
          config: node.config,
          signal: ctx.signal ?? new AbortController().signal,
        },
        (e) => {
          switch (e.kind) {
            case 'text':
              emit({ type: 'node_text', nodeId: node.id, delta: e.delta, at: Date.now() });
              break;
            case 'tool_start':
              emit({ type: 'node_tool', nodeId: node.id, phase: 'start', name: e.name, at: Date.now() });
              break;
            case 'tool_end':
              emit({
                type: 'node_tool',
                nodeId: node.id,
                phase: 'end',
                name: e.name,
                ok: e.ok,
                ms: e.ms,
                at: Date.now(),
              });
              break;
            case 'usage':
              usage.promptTokens += e.usage.promptTokens;
              usage.completionTokens += e.usage.completionTokens;
              usage.totalTokens += e.usage.totalTokens;
              break;
            case 'note':
              emit({ type: 'node_note', nodeId: node.id, level: e.level, message: e.message, at: Date.now() });
              break;
          }
        },
      );

      const ms = Date.now() - startedAt;

      // 「跑完了」和「得出结论了」是两件事。步数预算耗尽的输出往往是半成品，
      // 必须显式告警，否则下游会把半成品当结论合并进去。
      if (result.stopReason === 'max_steps') {
        emit({
          type: 'node_note',
          nodeId: node.id,
          level: 'warn',
          message: `步数预算（${node.maxSteps ?? '默认'}）耗尽，输出可能是半成品`,
          at: Date.now(),
        });
      }

      emit({
        type: 'node_end',
        nodeId: node.id,
        status: 'ok',
        ms,
        chars: result.text.length,
        at: Date.now(),
      });

      return {
        nodeId: node.id,
        agent: node.agent,
        text: result.text,
        steps: result.steps,
        toolsUsed: result.toolsUsed,
        // result.usage 是权威值；事件累加只在 Driver 只报流式用量、不给终值时才用
        usage: result.usage.totalTokens > 0 ? result.usage : usage,
        ms,
        status: 'ok',
        stopReason: result.stopReason,
        data: result.data,
      };
    } catch (err) {
      lastErr = err as Error;
      const isLast = attempt >= Math.max(1, retry.attempts);
      const delay = retry.backoff ? retry.delayMs * 2 ** (attempt - 1) : retry.delayMs;

      if (isLast) break;

      emit({
        type: 'node_retry',
        nodeId: node.id,
        attempt,
        delayMs: delay,
        reason: lastErr.message,
        at: Date.now(),
      });
      if (delay > 0) await sleep(delay, ctx.signal);
    }
  }

  // 失败原因必须打到事件流里。否则控制台只有一行「失败 0ms」，
  // 使用者拿不到任何可行动的信息。
  if (lastErr) {
    emit({ type: 'node_note', nodeId: node.id, level: 'error', message: lastErr.message, at: Date.now() });
  }

  emit({
    type: 'node_end',
    nodeId: node.id,
    status: 'failed',
    ms: 0,
    chars: 0,
    at: Date.now(),
  });

  return {
    nodeId: node.id,
    agent: node.agent,
    text: `节点失败：${lastErr?.message ?? '未知错误'}`,
    steps: 0,
    toolsUsed: [],
    usage: { ...ZERO_USAGE },
    ms: 0,
    status: 'failed',
  };
}

async function runForEach(node: NodeSpec, driver: AgentDriver, ctx: NodeRunCtx): Promise<NodeOutput> {
  const spec = node.forEach!;
  const raw = ctx.board.resolve(spec.over);
  if (!Array.isArray(raw)) {
    const reason = `${spec.over} 不是数组（实际：${typeof raw}）`;
    ctx.emit({ type: 'node_skip', nodeId: node.id, reason, at: Date.now() });
    return skipOutput(node, reason);
  }

  const items = spec.max ? raw.slice(0, spec.max) : raw;
  ctx.emit({
    type: 'node_note',
    nodeId: node.id,
    level: 'info',
    message: `循环执行 ${items.length} 次（${spec.over}）`,
    at: Date.now(),
  });

  const parts: NodeOutput[] = [];
  const usage: Usage = { ...ZERO_USAGE };

  for (let i = 0; i < items.length; i++) {
    const out = await runOnce(node, driver, ctx, { item: items[i] });
    parts.push(out);
    usage.promptTokens += out.usage.promptTokens;
    usage.completionTokens += out.usage.completionTokens;
    usage.totalTokens += out.usage.totalTokens;
    if (out.status === 'failed') break;
  }

  const failed = parts.some((p) => p.status === 'failed');
  return {
    nodeId: node.id,
    agent: node.agent,
    text: parts.map((p, i) => `### [${i + 1}]\n${p.text}`).join('\n\n'),
    steps: parts.reduce((s, p) => s + p.steps, 0),
    toolsUsed: parts.flatMap((p) => p.toolsUsed),
    usage,
    ms: parts.reduce((s, p) => s + p.ms, 0),
    status: failed ? 'failed' : 'ok',
    data: parts.map((p) => p.data),
  };
}

/** 把工作流级默认值摊平到每个节点上，让节点定义尽量短。 */
function applyDefaults(spec: WorkflowSpec): WorkflowSpec {
  if (!spec.defaults) return spec;
  const d = spec.defaults;
  return {
    ...spec,
    nodes: spec.nodes.map((n) => ({
      ...n,
      config: { ...(d.config ?? {}), ...(n.config ?? {}) },
      retry: n.retry ?? d.retry,
      maxSteps: n.maxSteps ?? d.maxSteps,
    })),
  };
}

/* ------------------------------------------------------------------ *
 * 工具函数
 * ------------------------------------------------------------------ */

function nodeWorkdir(node: NodeSpec, ctx: NodeRunCtx): string {
  const fromConfig = node.config?.['workdir'];
  if (typeof fromConfig === 'string' && fromConfig) return fromConfig;
  return ctx.workdir;
}

/** 模板里 {{item}} 已经由 render 替换过；这里只是把非字符串 item 序列化后补进去。 */
function withItem(prompt: string, scope: { item?: unknown }): string {
  if (scope.item === undefined) return prompt;
  return prompt.replace(/\{\{\s*item\s*\}\}/g, JSON.stringify(scope.item, null, 2));
}

/** 从模板中推导出「读了哪些上游」，用于追踪 Agent 间的数据流。 */
export function collectRefs(template: string): string[] {
  const refs = new Set<string>();
  for (const m of template.matchAll(/\{\{\s*([\p{L}\p{N}_$]+)[.\p{L}\p{N}_$]*\s*\}\}/gu)) {
    const head = m[1];
    if (head && head !== 'item' && head !== 'input') refs.add(head);
  }
  return [...refs];
}

export function evaluate(cond: Condition, board: Blackboard): boolean {
  const actual = board.resolve(cond.path);

  switch (cond.op) {
    case 'exists':
      return actual !== undefined && actual !== null;
    case 'empty':
      return actual === undefined || actual === null || actual === '' ||
        (Array.isArray(actual) && actual.length === 0);
    case 'eq':
      return looseEq(actual, cond.value);
    case 'ne':
      return !looseEq(actual, cond.value);
    default: {
      const a = Number(actual);
      const b = Number(cond.value);
      if (Number.isNaN(a) || Number.isNaN(b)) return false;
      switch (cond.op) {
        case 'gt':
          return a > b;
        case 'gte':
          return a >= b;
        case 'lt':
          return a < b;
        case 'lte':
          return a <= b;
      }
    }
  }
}

function looseEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  if (typeof a === 'object' || typeof b === 'object') {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return String(a) === String(b);
}

function failureOutput(node: NodeSpec, reason: string): NodeOutput {
  return {
    nodeId: node.id,
    agent: node.agent,
    text: `节点执行异常：${reason}`,
    steps: 0,
    toolsUsed: [],
    usage: { ...ZERO_USAGE },
    ms: 0,
    status: 'failed',
  };
}

function skipOutput(node: NodeSpec, reason: string): NodeOutput {
  return {
    nodeId: node.id,
    agent: node.agent,
    text: `（已跳过：${reason}）`,
    steps: 0,
    toolsUsed: [],
    usage: { ...ZERO_USAGE },
    ms: 0,
    status: 'skipped',
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Error('已取消'));
    }, { once: true });
  });
}

function makeRunId(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${Math.random().toString(36).slice(2, 6)}`;
}
