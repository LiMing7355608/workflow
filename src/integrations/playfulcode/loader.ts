/**
 * PlayfulCode 模块加载器。
 *
 * 只做两件事：加载 + 契约校验。
 * 契约校验是刻意的：如果上游删了某个导出，这里立刻报出缺了哪个，
 * 而不是等某个节点跑到一半才抛 undefined is not a function。
 */

import path from 'node:path';
import type { PcModule } from './types';

const moduleCache = new Map<string, PcModule>();

export function loadPlayfulCode(rootDir: string): PcModule {
  const entry = path.resolve(rootDir, 'dist', 'index.js');
  const cached = moduleCache.get(entry);
  if (cached) return cached;

  let loaded: unknown;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    loaded = require(entry);
  } catch (err) {
    throw new Error(
      `无法加载 PlayfulCode：${entry}\n` +
        `请确认路径正确且已执行 npm run build。原始错误：${(err as Error).message}`,
    );
  }

  const mod = loaded as Partial<PcModule>;
  const required: (keyof PcModule)[] = [
    'createAgent',
    'createReviewRegistry',
    'resolveConfig',
    'loadDotEnv',
    'validateConfig',
    'scanPath',
    'renderReportText',
  ];
  const missing = required.filter((k) => typeof mod[k] !== 'function');
  if (missing.length > 0) {
    throw new Error(`PlayfulCode 契约不匹配，缺少导出：${missing.join('、')}`);
  }

  moduleCache.set(entry, mod as PcModule);
  return mod as PcModule;
}
