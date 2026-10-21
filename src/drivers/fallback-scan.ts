/**
 * 内置静态扫描器。
 *
 * 存在的唯一理由：**没有 PlayfulCode 时项目仍然能跑。**
 * 工作流引擎不该被某一个 Agent 的安装状态绑死——评审者 clone 下来
 * 只有 Node，也应该能看到一条完整流水线跑通。
 *
 * 规则刻意做得少而准，不与 PlayfulCode 的规则集竞争。
 * 配置了 PC_ROOT 时优先用 PlayfulCode 的扫描器，这里只是兜底。
 */

import fs from 'node:fs';
import path from 'node:path';

export type Severity = 'critical' | 'high' | 'medium' | 'low';

export interface FallbackFinding {
  ruleId: string;
  title: string;
  severity: Severity;
  file: string;
  line: number;
  message: string;
  suggestion: string;
}

export interface FallbackReport {
  files: number;
  lines: number;
  findings: FallbackFinding[];
  bySeverity: Record<Severity, number>;
  text: string;
}

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'runs', 'workspace', '.idea', 'coverage']);
const EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const MAX_FILES = 400;
const MAX_BYTES = 512 * 1024;

interface Rule {
  id: string;
  title: string;
  severity: Severity;
  test: RegExp;
  message: string;
  suggestion: string;
}

const RULES: Rule[] = [
  {
    id: 'SEC-001',
    title: 'eval / new Function 执行动态代码',
    severity: 'high',
    test: /\beval\s*\(|new\s+Function\s*\(/,
    message: '动态执行字符串代码，输入不可信时等同于任意代码执行',
    suggestion: '改用白名单解析或预定义函数表',
  },
  {
    id: 'SEC-002',
    title: '疑似硬编码密钥',
    severity: 'high',
    test: /\b(api[_-]?key|secret|token|password)\b\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]/i,
    message: '密钥直接写在源码里，会随仓库一起泄露',
    suggestion: '移到环境变量或 .env，并加入 .gitignore',
  },
  {
    id: 'ERR-001',
    title: '空的 catch 块',
    severity: 'medium',
    test: /catch\s*(\([^)]*\))?\s*\{\s*\}/,
    message: '异常被静默吞掉，出问题时没有任何线索',
    suggestion: '至少记录日志，或显式说明为何可以忽略',
  },
  {
    id: 'QUA-001',
    title: '使用 any 类型',
    severity: 'low',
    test: /:\s*any\b|<any>/,
    message: 'any 关闭了类型检查，契约会在这里断掉',
    suggestion: '用具体类型或 unknown + 收窄',
  },
  {
    id: 'QUA-002',
    title: '遗留调试输出',
    severity: 'low',
    test: /\bconsole\.(log|debug)\s*\(/,
    message: '直接输出到标准输出，会污染 CLI 结果且无法按级别关闭',
    suggestion: '换成统一 logger；CLI 入口的交互输出可忽略',
  },
  {
    id: 'QUA-003',
    title: '未完成的标记',
    severity: 'low',
    test: /\b(TODO|FIXME|XXX)\b/,
    message: '代码里留有未完成事项',
    suggestion: '转成任务单，或补完再合并',
  },
];

/** 递归收集待扫描文件。 */
function collectFiles(root: string, max = MAX_FILES): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (out.length >= max) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= max) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(full);
      } else if (EXTS.has(path.extname(e.name))) {
        out.push(full);
      }
    }
  };
  walk(path.resolve(root));
  return out;
}

export function scanFallback(workdir: string, target = '.'): FallbackReport {
  const root = path.resolve(workdir, target);
  const files = collectFiles(root);
  const findings: FallbackFinding[] = [];
  let lines = 0;

  for (const file of files) {
    let text: string;
    try {
      const stat = fs.statSync(file);
      if (stat.size > MAX_BYTES) continue;
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    const rel = path.relative(workdir, file).split(path.sep).join('/');
    const rows = text.split(/\r?\n/);
    lines += rows.length;

    rows.forEach((row, i) => {
      for (const rule of RULES) {
        if (!rule.test.test(row)) continue;
        // 调试输出规则在 CLI 入口是合理的，噪声不值得报
        if (rule.id === 'QUA-002' && /(^|\/)cli\.ts$/.test(rel)) continue;
        findings.push({
          ruleId: rule.id,
          title: rule.title,
          severity: rule.severity,
          file: rel,
          line: i + 1,
          message: rule.message,
          suggestion: rule.suggestion,
        });
      }
    });
  }

  const bySeverity: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) bySeverity[f.severity] += 1;

  return { files: files.length, lines, findings, bySeverity, text: render(files.length, lines, findings, bySeverity) };
}

const WEIGHT: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

function render(
  fileCount: number,
  lineCount: number,
  findings: FallbackFinding[],
  bySeverity: Record<Severity, number>,
): string {
  const out = [
    `扫描：${fileCount} 个文件 / ${lineCount} 行（内置扫描器；未配置 PC_ROOT，未使用 PlayfulCode）`,
    `统计：严重 ${bySeverity.critical} · 高 ${bySeverity.high} · 中 ${bySeverity.medium} · 低 ${bySeverity.low}`,
  ];
  if (findings.length === 0) {
    out.push('未发现问题。');
    return out.join('\n');
  }

  out.push('');
  const sorted = [...findings].sort((a, b) => WEIGHT[a.severity] - WEIGHT[b.severity] || a.file.localeCompare(b.file));
  for (const f of sorted) {
    out.push(`${f.severity.toUpperCase()} ${f.file}:${f.line} [${f.ruleId}] ${f.title}`);
    out.push(`     ${f.message}`);
    out.push(`     → ${f.suggestion}`);
  }
  return out.join('\n');
}
