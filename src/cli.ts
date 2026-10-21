#!/usr/bin/env node
/**
 * 命令行入口。
 *
 *   workflow run <spec.json>     跑一个工作流
 *   workflow validate <spec.json> 只做静态校验
 *   workflow web [dir]            启动可视化编排界面（默认 workflows 目录）
  workflow agents               列出所有 Agent 驱动及其安装状态
  workflow probe <agent>        打印某个外部 CLI 的 --help，用于核对参数
  workflow doctor               检查 PlayfulCode 接入与密钥
 */

import fs from 'node:fs';
import path from 'node:path';
import { runWorkflow, validateSpec } from './core/engine';
import { createConsoleReporter, createFileTracer, fanout } from './core/trace';
import { createDrivers } from './registry';
import { loadEnvFile } from './core/env';
import type { WorkflowSpec } from './core/types';

interface Flags {
  mock: boolean;
  verbose: boolean;
  workdir?: string;
  pcRoot: string;
  provider?: string;
  model?: string;
  concurrency?: number;
  out?: string;
  host?: string;
  port?: number;
}

function parseFlags(argv: string[]): { cmd: string; target?: string; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = {
    mock: false,
    verbose: false,
    pcRoot: process.env['PC_ROOT'] ?? process.env['PLAYFULCODE_ROOT'] ?? '',
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case '--mock':
        flags.mock = true;
        break;
      case '--verbose':
      case '-v':
        flags.verbose = true;
        break;
      case '--workdir':
        flags.workdir = argv[++i];
        break;
      case '--pc-root':
        flags.pcRoot = argv[++i] ?? flags.pcRoot;
        break;
      case '--provider':
        flags.provider = argv[++i];
        break;
      case '--model':
        flags.model = argv[++i];
        break;
      case '--concurrency':
        flags.concurrency = Number(argv[++i]);
        break;
      case '--out':
        flags.out = argv[++i];
        break;
      case '--host':
        flags.host = argv[++i];
        break;
      case '--port':
        flags.port = Number(argv[++i]);
        break;
      default:
        positional.push(a);
    }
  }

  return { cmd: positional[0] ?? 'help', target: positional[1], flags };
}

function loadSpec(file: string): { spec: WorkflowSpec; dir: string } {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new Error(`找不到工作流文件：${abs}`);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (err) {
    throw new Error(`工作流文件不是合法 JSON：${(err as Error).message}`);
  }
  return { spec: raw as WorkflowSpec, dir: path.dirname(abs) };
}

async function main(): Promise<number> {
  loadEnvFile();
  const { cmd, target, flags } = parseFlags(process.argv.slice(2));


  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    printHelp();
    return 0;
  }

  if (cmd === 'doctor') {
    return doctor(flags);
  }

  if (cmd === 'agents') {
    const { listCliStatus } = await import('./drivers/cli');
    const rows = listCliStatus();
    // 按显示宽度补齐：中文占两列
    const width = (s: string): number => [...s].reduce((w, ch) => w + (/[一-龥]/.test(ch) ? 2 : 1), 0);
    const pad = (s: string, n: number): string => s + ' '.repeat(Math.max(0, n - width(s)));
    console.log(`\n${pad('AGENT', 14)}${pad('可执行文件', 14)}${pad('状态', 10)}来源`);
    console.log('─'.repeat(62));
    for (const r of rows) {
      const state = r.available ? '已安装' : '未安装';
      const src = r.verified ? '本机实测' : r.source ? '官方文档' : '未核实';
      console.log(pad(r.kind, 14) + pad(r.bin, 14) + pad(state, 10) + src);
    }
    console.log('\n内置：playfulcode（项目1 Agent）· fn:scan（确定性节点）· mock（离线）\n');
    return 0;
  }

  if (cmd === 'probe') {
    if (!target) throw new Error('用法：workflow probe <agent>');
    const { probeCli } = await import('./drivers/cli');
    const r = probeCli(target);
    console.log(r.output);
    return r.ok ? 0 : 1;
  }

  if (cmd === 'web') {
    const { startWeb } = await import('./web/server');
    const workflowsDir = path.resolve(target ?? 'workflows');
    if (!fs.existsSync(workflowsDir)) throw new Error(`工作流目录不存在：${workflowsDir}`);
    await startWeb({
      workflowsDir,
      workdir: flags.workdir ? path.resolve(flags.workdir) : path.resolve('src'),
      playfulCodeRoot: flags.pcRoot,
      host: flags.host,
      port: flags.port,
    });
    // 常驻进程：不返回退出码
    return await new Promise<number>(() => {});
  }

  if (cmd === 'validate') {
    if (!target) throw new Error('用法：workflow validate <spec.json>');
    const { spec } = loadSpec(target);
    const problems = validateSpec(spec);
    if (problems.length > 0) {
      console.error(`✗ ${problems.length} 个问题：\n- ${problems.join('\n- ')}`);
      return 1;
    }
    console.log(`✓ ${spec.name}：${spec.nodes.length} 个节点，依赖关系合法`);
    return 0;
  }

  if (cmd === 'run') {
    if (!target) throw new Error('用法：workflow run <spec.json>');
    const { spec, dir } = loadSpec(target);

    // 工作流里的 workdir 相对于工作流文件自身，而不是进程 cwd ——
    // 这样无论从哪个目录调用，行为都一致。
    const workdir = flags.workdir ? path.resolve(flags.workdir) : path.resolve(dir, spec.workdir ?? '.');
    const drivers = createDrivers({
      playfulCodeRoot: flags.pcRoot,
      provider: flags.provider,
      model: flags.model,
      mock: flags.mock,
    });

    const sinks = fanout(
      createConsoleReporter({ verbose: flags.verbose }),
      createFileTracer(flags.out ?? path.resolve('runs')),
    );
    const emit = sinks.handle;

    const summary = await runWorkflow(
      { ...spec, workdir },
      {
        drivers,
        workdir,
        emit,
        concurrency: flags.concurrency,
        signal: makeAbortSignal(),
      },
    );

    sinks.close({ runId: summary.runId, outputs: summary.outputs });

    console.log(`用量：${summary.usage.totalTokens} tokens（输入 ${summary.usage.promptTokens} / 输出 ${summary.usage.completionTokens}）`);
    console.log(`产出：${path.resolve(flags.out ?? 'runs', summary.runId)}`);
    return summary.status === 'ok' ? 0 : 1;
  }

  printHelp();
  return 2;
}

async function doctor(flags: Flags): Promise<number> {
  if (!flags.pcRoot) {
    // PlayfulCode 是可选依赖：没有它项目照样能跑，只是 playfulcode 节点不可用
    console.log('○ 未配置 PlayfulCode（可选）。');
    console.log('  · playfulcode 节点将不可用');
    console.log('  · fn:scan 会退回内置扫描器');
    console.log('  如需启用：在 .env 里写 PC_ROOT=<PlayfulCode 仓库路径>');
    console.log('');
    return 0;
  }
  console.log(`PlayfulCode 根目录：${flags.pcRoot}`);
  try {
    // 延迟 import，避免 doctor 也依赖 dist 已构建
    const { PlayfulCodeDriver } = await import('./drivers/playfulcode');
    const driver = new PlayfulCodeDriver({
      rootDir: flags.pcRoot,
      provider: flags.provider,
      model: flags.model,
    });
    const info = driver.probe();
    console.log(`版本：${driver.version}`);
    console.log(`服务商：${info.provider}  模型：${info.model}`);
    if (!info.ok) {
      console.error(`✗ 配置不完整：\n- ${info.problems.join('\n- ')}`);
      return 1;
    }
    console.log('✓ 配置可用');
    return 0;
  } catch (err) {
    console.error(`✗ ${(err as Error).message}`);
    return 1;
  }
}

function makeAbortSignal(): AbortSignal {
  const ac = new AbortController();
  const stop = (): void => {
    console.error('\n收到中断，正在停止…');
    ac.abort();
  };
  process.once('SIGINT', stop);
  return ac.signal;
}

function printHelp(): void {
  console.log(`workflow —— 多 Agent 工作流 MVP

用法：
  workflow run <spec.json>       执行工作流
  workflow validate <spec.json>  只做静态校验（依赖、环）
  workflow web [dir]            启动可视化编排界面（默认 workflows 目录）
  workflow agents               列出所有 Agent 驱动及其安装状态
  workflow probe <agent>        打印某个外部 CLI 的 --help，用于核对参数
  workflow doctor               检查 PlayfulCode 接入与密钥

选项：
  --mock                用 Mock 替换所有 LLM 节点（离线）
  --workdir <dir>       覆盖工作流的工作目录
  --pc-root <dir>       PlayfulCode 仓库根目录（默认读 PC_ROOT / .env）
  --provider <id>       覆盖 LLM 服务商（deepseek/openai/...）
  --model <id>          覆盖模型
  --concurrency <n>     并行节点上限（默认 4）
  --out <dir>           追踪输出目录（默认 ./runs）
  --host / --port       编排界面监听地址（默认 127.0.0.1:3081）
  -v, --verbose         输出更详细的工具与提示信息`);
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`✗ ${(err as Error).message}`);
    process.exit(1);
  });
