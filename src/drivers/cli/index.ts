/**
 * CLI 平台注册与探测。
 */

import { spawnSync } from 'node:child_process';
import type { AgentDriver } from '../../core/types';
import { CliAgentDriver } from './driver';
import { CLI_PRESETS, findPreset } from './presets';
import type { CliAgentSpec } from './types';

export interface CliStatus {
  kind: string;
  label: string;
  bin: string;
  available: boolean;
  verified: boolean;
  note?: string;
  source?: string;
}

/** 可执行文件是否在 PATH 里。 */
export function commandExists(bin: string): boolean {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  try {
    const r = spawnSync(probe, [bin], { stdio: 'ignore', shell: false, timeout: 5000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

export function listCliStatus(): CliStatus[] {
  return CLI_PRESETS.map((p) => ({
    kind: p.kind,
    label: p.label,
    bin: p.bin,
    available: commandExists(p.bin),
    verified: p.verified,
    ...(p.note ? { note: p.note } : {}),
    ...(p.source ? { source: p.source } : {}),
  }));
}

/** 构造全部 CLI Driver。构造本身不启动进程，所以可以一次性全注册。 */
export function createCliDrivers(): Record<string, AgentDriver> {
  const out: Record<string, AgentDriver> = {};
  for (const spec of CLI_PRESETS) out[spec.kind] = new CliAgentDriver(spec);
  return out;
}

/** 运行 `<bin> --help`，把输出原样打印出来供人工核对参数。 */
export function probeCli(kind: string): { ok: boolean; output: string } {
  const spec = findPreset(kind);
  if (!spec) return { ok: false, output: `未知的 CLI 平台：${kind}` };

  if (!commandExists(spec.bin)) {
    return { ok: false, output: `找不到可执行文件 ${spec.bin}（不在 PATH 中）` };
  }

  const r = spawnSync(spec.bin, ['--help'], {
    encoding: 'utf8',
    timeout: 15_000,
    shell: process.platform === 'win32',
  });
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  return { ok: r.status === 0, output: output || '(无输出)' };
}

export { CLI_PRESETS, findPreset };
export type { CliAgentSpec };
