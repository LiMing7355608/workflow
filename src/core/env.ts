/**
 * 极简 .env 加载。
 *
 * 只做一件事：把 KEY=VALUE 写进 process.env，且**不覆盖**已存在的变量。
 * 之所以自己写而不引依赖：格式就这几行，多一个包不如多一行注释。
 *
 * 存在的原因很实际——仓库里不能出现本机绝对路径，
 * 而"PlayfulCode 在哪"又是每台机器都不同的配置。
 */

import fs from 'node:fs';
import path from 'node:path';

export function loadEnvFile(dir = process.cwd(), file = '.env'): number {
  const full = path.join(dir, file);
  if (!fs.existsSync(full)) return 0;

  let text: string;
  try {
    text = fs.readFileSync(full, 'utf8');
  } catch {
    return 0;
  }

  let loaded = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq <= 0) continue;

    const key = line.slice(0, eq).replace(/^export\s+/, '').trim();
    let value = line.slice(eq + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
      loaded += 1;
    }
  }
  return loaded;
}
