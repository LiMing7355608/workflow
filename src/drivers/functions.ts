/**
 * 确定性节点（Function Driver）。
 *
 * 工作流里不是每一步都该交给模型。像「跑一遍静态规则」这种事情，
 * 结果是确定的、可复现的、零成本的，交给模型反而是退步。
 *
 * 把它做成 Driver 而不是「引擎里的特殊分支」，是为了让引擎彻底不知道
 * 「这一节点背后是 LLM 还是函数」——这正是可扩展性的具体体现：
 * 新增一种节点能力，加一个 Driver，引擎一行不改。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { AgentDriver, AgentResult, AgentTask, DriverEvent, Usage } from '../core/types';
import { loadPlayfulCode } from '../integrations/playfulcode/loader';
import type { PcScanReport } from '../integrations/playfulcode/types';
import { scanFallback } from './fallback-scan';

const NO_USAGE: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

export interface StaticScanConfig {
  rootDir: string;
  /** 相对 workdir 的扫描目标，默认 '.' */
  target?: string;
}

export class StaticScanDriver implements AgentDriver {
  readonly kind = 'fn:scan';
  readonly capabilities = {
    streaming: false,
    structured: true,
    resume: false,
    tools: false,
  };

  async run(task: AgentTask, emit: (e: DriverEvent) => void): Promise<AgentResult> {
    const cfg = (task.config ?? {}) as Partial<StaticScanConfig>;
    const target = cfg.target ?? '.';
    const rootDir = cfg.rootDir ?? process.env['PC_ROOT'];

    // 装了 PlayfulCode 就用它的规则引擎；没有就用内置扫描器。
    // 这条分支的意义是：本项目不依赖项目一也能跑通完整流程。
    const hasPc = Boolean(rootDir) && fs.existsSync(path.join(rootDir!, 'dist', 'index.js'));
    emit({ kind: 'note', level: 'info', message: `扫描 ${task.workdir} 下的 ${target}` });

    if (!hasPc) {
      const report = scanFallback(task.workdir, target);
      emit({
        kind: 'note',
        level: 'info',
        message: '未配置 PC_ROOT，使用内置扫描器（配置后可换回 PlayfulCode 的规则引擎）',
      });
      emit({ kind: 'text', delta: report.text });
      emit({ kind: 'usage', usage: NO_USAGE });
      return {
        text: report.text,
        steps: 1,
        toolsUsed: [],
        usage: NO_USAGE,
        data: {
          findings: report.findings,
          stats: { files: report.files, lines: report.lines, bySeverity: report.bySeverity },
          scanner: 'builtin',
        },
      };
    }

    const pc = loadPlayfulCode(rootDir!);
    const report: PcScanReport = pc.scanPath({ target, workdir: task.workdir });
    const text = pc.renderReportText(report);

    emit({ kind: 'text', delta: text });
    emit({ kind: 'usage', usage: NO_USAGE });

    return {
      text,
      steps: 1,
      toolsUsed: [],
      usage: NO_USAGE,
      data: {
        findings: report.findings,
        stats: report.stats,
        files: report.files,
        scanner: 'playfulcode',
      },
    };
  }
}
