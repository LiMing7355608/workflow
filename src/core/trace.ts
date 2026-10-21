/**
 * 执行追踪。
 *
 * 两层：
 *   1. JSONL 事件流 —— 机器可读，出问题能逐条回放；
 *   2. 控制台渲染器 —— 人可读，演示时直接看。
 *
 * 另外每个节点的最终产出会单独落一份 .md，
 * 这样「Agent 之间到底传了什么」是可以直接打开看的，而不是靠猜。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { NodeOutput, WorkflowEvent } from './types';

const C = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  bold: '\u001b[1m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  red: '\u001b[31m',
  cyan: '\u001b[36m',
  gray: '\u001b[90m',
};

const useColor = process.stdout.isTTY && !process.env['NO_COLOR'];
const c = (code: string, s: string): string => (useColor ? `${code}${s}${C.reset}` : s);

/**
 * 终端转义清洗。
 * nodeId / agent / message 的源头是工作流 JSON 与模型输出，属于不可信输入。
 * 原样打到终端可以被 \x1b]52 之类序列改写剪贴板、伪造「校验通过」。
 * 这是本项目自己代码里唯一需要防御的地方，成本一行。
 */
// eslint-disable-next-line no-control-regex
const strip = (s: string): string => s.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');

export interface TraceSink {
  handle(e: WorkflowEvent): void;
  close(summary?: { runId: string; outputs: Record<string, NodeOutput> }): void;
}

/** 把事件追加到 runs/<runId>/trace.jsonl。 */
export function createFileTracer(baseDir = path.resolve('runs')): TraceSink {
  let dir: string | undefined;
  let stream: fs.WriteStream | undefined;

  const ensure = (runId: string): void => {
    if (dir) return;
    dir = path.join(baseDir, runId);
    fs.mkdirSync(dir, { recursive: true });
    stream = fs.createWriteStream(path.join(dir, 'trace.jsonl'), { flags: 'a' });
  };

  return {
    handle(e) {
      if ('runId' in e) ensure(e.runId);
      if (!stream && dir === undefined) {
        // 理论上 workflow_start 总是第一个事件；兜底避免丢事件
        ensure('unknown');
      }
      stream?.write(`${JSON.stringify(e)}\n`);
    },
    close(summary) {
      if (summary && dir) {
        // 再落一份纯文本产出，方便 diff 与人工复核
        const lines = Object.values(summary.outputs).map(
          (o) => `# ${o.nodeId} (${o.agent}) — ${o.status}\n\n${o.text}\n`,
        );
        fs.writeFileSync(path.join(dir, 'outputs.md'), lines.join('\n---\n'));
      }
      stream?.end();
    },
  };
}

/** 控制台渲染。节点启动/结束各一行，工具调用缩进一行。 */
export function createConsoleReporter(opts: { verbose?: boolean } = {}): TraceSink {
  const startedAt = new Map<string, number>();
  const t0 = Date.now();
  const el = (): string => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

  return {
    handle(e) {
      switch (e.type) {
        case 'workflow_start':
          console.log(
            `\n${c(C.bold, '▶ 工作流')} ${c(C.cyan, strip(e.name))}  ${c(C.gray, `${e.nodes} 个节点 · run ${strip(e.runId)}`)}`,
          );
          break;

        case 'node_start': {
          startedAt.set(e.nodeId, Date.now());
          const deps = e.consumes.length > 0 ? c(C.gray, ` ← ${e.consumes.map(strip).join(', ')}`) : '';
          const attempt = e.attempt > 1 ? c(C.yellow, ` (第 ${e.attempt} 次)`) : '';
          console.log(`  ${c(C.bold, '⚙')} ${strip(e.nodeId)} ${c(C.gray, `[${strip(e.agent)}]`)}${deps}${attempt}`);
          break;
        }

        case 'node_tool':
          if (e.phase === 'end') {
            const mark = e.ok ? c(C.green, '✓') : c(C.red, '✗');
            console.log(`      ${mark} ${strip(e.name)} ${c(C.gray, `${e.ms ?? 0}ms`)}`);
          } else if (opts.verbose) {
            console.log(`      ${c(C.dim, '→')} ${strip(e.name)}`);
          }
          break;

        case 'node_retry':
          console.log(`      ${c(C.yellow, `↻ 重试 ${e.attempt}，${e.delayMs}ms 后`)} ${c(C.gray, strip(e.reason))}`);
          break;

        case 'node_note':
          if (e.level === 'error' || opts.verbose) {
            const tone = e.level === 'error' ? C.red : e.level === 'warn' ? C.yellow : C.dim;
            console.log(`      ${c(tone, `${e.level}: ${strip(e.message)}`)}`);
          }
          break;

        case 'node_skip':
          console.log(`      ${c(C.gray, `⊘ ${strip(e.nodeId)} 跳过：${strip(e.reason)}`)}`);
          break;

        case 'node_end': {
          const start = startedAt.get(e.nodeId) ?? Date.now();
          const ms = Date.now() - start;
          const tone = e.status === 'ok' ? C.green : e.status === 'skipped' ? C.gray : C.red;
          const label = e.status === 'ok' ? '完成' : e.status === 'skipped' ? '跳过' : '失败';
          console.log(
            `      ${c(tone, label)} ${c(C.gray, `${ms}ms · ${e.chars} 字符`)}  ${c(C.gray, el())}`,
          );
          break;
        }

        case 'workflow_end': {
          const tone = e.status === 'ok' ? C.green : C.red;
          console.log(`\n${c(tone, `■ 结束（${e.status}）`)} ${c(C.gray, `${(e.ms / 1000).toFixed(1)}s`)}\n`);
          break;
        }

        default:
          break;
      }
    },
    close() {
      /* 控制台无需收尾 */
    },
  };
}

/** 显式分发给多个 sink；单个 sink 抛错不影响其他 sink。 */
export function fanout(...sinks: TraceSink[]): TraceSink {
  return {
    handle(e) {
      for (const s of sinks) {
        try {
          s.handle(e);
        } catch {
          /* 追踪失败不能拖垮工作流 */
        }
      }
    },
    close(summary) {
      for (const s of sinks) {
        try {
          s.close(summary);
        } catch {
          /* ignore */
        }
      }
    },
  };
}
