/**
 * 通用 CLI Agent Driver。
 *
 * 一个类吃下所有「只能当子进程跑」的平台：Claude Code、Codex、以及任何
 * 长得像它们的 CLI。平台差异全部收敛到 CliAgentSpec（参数模板 + 解析器）。
 *
 * 为什么不把 prompt 拼进命令行参数：
 * Windows 上 npm 安装的 CLI 是个 .cmd 包装，必须经过 shell，
 * 而 shell 会把参数再解析一遍 —— 只要 prompt 里有引号、&、| 就会出事。
 * 所以默认走 stdin，参数模板里只放静态开关。
 */

import { spawn } from 'node:child_process';
import readline from 'node:readline';
import type { AgentDriver, AgentResult, AgentTask, DriverEvent, Usage } from '../../core/types';
import type { CliAgentSpec } from './types';
import { emptyState } from './types';
import { PARSERS } from './parsers';

interface NodeConfig {
  /** 覆盖可执行文件 */
  bin?: string;
  /** 覆盖参数模板 */
  args?: string[];
  model?: string;
  /** 追加在最后的参数 */
  extraArgs?: string[];
  /** 允许的工具（Claude Code 用） */
  allowedTools?: string;
  /** 覆盖子进程的工作目录（例如从源码跑 pnpm 脚本时指向仓库根） */
  cwd?: string;
  timeoutMs?: number;
}

export class CliAgentDriver implements AgentDriver {
  readonly kind: string;
  readonly capabilities;
  readonly spec: CliAgentSpec;

  constructor(spec: CliAgentSpec) {
    this.spec = spec;
    this.kind = spec.kind;
    this.capabilities = spec.capabilities;
  }

  async run(task: AgentTask, emit: (e: DriverEvent) => void): Promise<AgentResult> {
    const cfg = (task.config ?? {}) as NodeConfig;
    const spec = this.spec;
    const bin = cfg.bin ?? spec.bin;
    const template = cfg.args ?? spec.args;

    const args = template
      .map((a) => this.fill(a, task, cfg))
      .concat((cfg.extraArgs ?? []).map((a) => this.fill(a, task, cfg)));

    if (cfg.model && spec.modelArgs) {
      args.push(...spec.modelArgs.map((a) => a.replace('{model}', cfg.model!)));
    }
    if (cfg.allowedTools && spec.kind === 'claude') {
      args.push('--allowedTools', cfg.allowedTools);
    }

    const wantsPromptArg = template.some((a) => a.includes('{prompt}'));
    const state = emptyState();
    const parser = PARSERS[spec.parser] ?? PARSERS['plain']!;

    /**
     * Windows 上 npm 安装的 CLI 是 .cmd 包装，必须经 shell 才能启动；
     * 而 `spawn(bin, args, {shell:true})` 是「拼接而非转义」，Node 会报弃用警告。
     * 所以 Windows 下自己拼成一条命令串（参数都是静态开关，且 prompt 走 stdin），
     * 其余平台正常传参数数组。
     */
    const isWin = process.platform === 'win32';
    const child = isWin
      ? spawn([bin, ...args].map(quoteWin).join(' '), {
          cwd: cfg.cwd ?? (task.workdir || undefined),
          env: { ...process.env, ...spec.env },
          shell: true,
          windowsHide: true,
        })
      : spawn(bin, args, {
          cwd: cfg.cwd ?? (task.workdir || undefined),
          env: { ...process.env, ...spec.env },
          windowsHide: true,
        });

    let stderr = '';
    child.stderr?.on('data', (b: Buffer) => {
      const s = b.toString();
      stderr = (stderr + s).slice(-4000);
    });

    if (!wantsPromptArg && spec.stdin !== false) {
      child.stdin?.write(task.prompt);
      child.stdin?.end();
    }

    const rl = readline.createInterface({ input: child.stdout! });
    let lineNo = 0;
    rl.on('line', (line) => {
      lineNo += 1;
      try {
        parser(line, state, emit);
      } catch {
        // 单行解析失败不该拖垮整个节点
      }
    });

    const timeoutMs = cfg.timeoutMs ?? spec.timeoutMs ?? 10 * 60_000;
    const outcome = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`${spec.label} 超时（${Math.round(timeoutMs / 1000)}s）`));
      }, timeoutMs);

      const onAbort = (): void => {
        child.kill('SIGTERM');
        clearTimeout(timer);
        reject(new Error('已取消'));
      };
      task.signal.addEventListener('abort', onAbort, { once: true });

      child.on('error', (err) => {
        clearTimeout(timer);
        task.signal.removeEventListener('abort', onAbort);
        reject(
          new Error(
            `无法启动 ${bin}：${err.message}\n` +
              `请确认已安装 ${spec.label} 并在 PATH 中，或在节点 config 里指定 bin。`,
          ),
        );
      });

      child.on('close', (code, signal) => {
        clearTimeout(timer);
        task.signal.removeEventListener('abort', onAbort);
        resolve({ code, signal });
      });
    });

    if (state.error) throw new Error(`${spec.label}：${state.error}`);
    if (outcome.code !== 0) {
      throw new Error(
        `${spec.label} 退出码 ${outcome.code ?? outcome.signal}\n${stderr.trim().slice(-800)}`,
      );
    }
    if (lineNo === 0) {
      throw new Error(`${spec.label} 没有输出任何内容\n${stderr.trim().slice(-800)}`);
    }

    const text = (state.finalText ?? state.chunks.join('')).trim();
    if (!text) {
      throw new Error(`${spec.label} 没有返回文本结果\n${stderr.trim().slice(-800)}`);
    }

    const usage: Usage = state.usage;

    return {
      text,
      steps: 1,
      toolsUsed: dedupe(state.toolsUsed),
      usage,
      stopReason: state.stopReason,
    };
  }

  private fill(arg: string, task: AgentTask, cfg: NodeConfig): string {
    return arg
      .replace('{prompt}', task.prompt)
      .replace('{workdir}', task.workdir)
      .replace('{model}', cfg.model ?? '');
  }
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}

/** cmd.exe 的参数引号：只在含有特殊字符时加引号。 */
function quoteWin(arg: string): string {
  if (arg === '') return '""';
  return /[\s"&|<>^()]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}
