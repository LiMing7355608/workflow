/**
 * Driver 注册表。
 *
 * 这是「新增一个平台要改哪里」的唯一答案：
 * 加一个文件实现 AgentDriver，在这里注册一行，工作流 JSON 里就能用。
 * 引擎、黑板、追踪、CLI 全部零改动。
 */

import type { AgentDriver } from './core/types';
import { PlayfulCodeDriver } from './drivers/playfulcode';
import { StaticScanDriver } from './drivers/functions';
import { MockDriver } from './drivers/mock';
import { createCliDrivers, CLI_PRESETS } from './drivers/cli';
import { UnavailableDriver } from './drivers/unavailable';

export interface DriverFactoryOptions {
  /** PlayfulCode 仓库根目录 */
  playfulCodeRoot: string;
  /** 默认服务商 / 模型 */
  provider?: string;
  model?: string;
  /** 用 Mock 替换所有 LLM 节点（离线演示 / 引擎测试） */
  mock?: boolean;
}

export function createDrivers(opts: DriverFactoryOptions): Record<string, AgentDriver> {
  const drivers: Record<string, AgentDriver> = {
    'fn:scan': new StaticScanDriver(),
  };

  if (opts.mock) {
    // 模拟运行时不应把外部 CLI 也拉起来，否则「离线演示」就名不副实了。
    // 但仍然注册同名替身，这样引用了 claude/codex 的工作流在离线模式下照样能跑通。
    drivers['playfulcode'] = new MockDriver();
    drivers['mock'] = new MockDriver();
    for (const spec of CLI_PRESETS) drivers[spec.kind] = new MockDriver(spec.kind);
    return drivers;
  }

  drivers['playfulcode'] = createPlayfulCode(opts);
  drivers['mock'] = new MockDriver();

  // 外部 CLI 平台：构造不启动进程，未安装的也能注册，运行时才报错
  Object.assign(drivers, createCliDrivers());

  return drivers;
}

/**
 * PlayfulCode 是可选依赖。
 * 没配置 PC_ROOT 或没构建时，注册一个占位 Driver：项目其余部分照常可用，
 * 只有真的用到这个 Agent 的节点才会失败，并说清楚缺什么。
 */
function createPlayfulCode(opts: DriverFactoryOptions): AgentDriver {
  if (!opts.playfulCodeRoot) {
    return new UnavailableDriver(
      'playfulcode',
      '该节点使用 PlayfulCode Agent，但未配置 PC_ROOT。' +
        '在项目根目录的 .env 里写 PC_ROOT=<PlayfulCode 仓库路径>，或把该节点的 agent 换成 claude / dsh。',
    );
  }
  try {
    return new PlayfulCodeDriver({
      rootDir: opts.playfulCodeRoot,
      provider: opts.provider,
      model: opts.model,
    });
  } catch (err) {
    return new UnavailableDriver('playfulcode', (err as Error).message);
  }
}
