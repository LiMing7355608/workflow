/**
 * 各平台预设。
 *
 * 参数来源全部是查到的官方文档或官方仓库（见每条 source）。
 * `verified` 的语义严格限定为「**在本机真的跑通过**」——
 * 查了文档但没装、没跑过的，一律 false，界面上会标「已验证参数」而不是「已实测」。
 *
 * 版本变化是常态：换版本后先跑 `workflow probe <kind>` 看 --help，再改这里。
 */

import type { CliAgentSpec } from './types';

export const CLI_PRESETS: CliAgentSpec[] = [
  /* ---------------------------------------------------------------- *
   * Claude Code —— 本机实测跑通
   * ---------------------------------------------------------------- */
  {
    kind: 'claude',
    label: 'Claude Code',
    bin: 'claude',
    args: ['-p', '--output-format', 'stream-json', '--verbose', '--allowedTools', 'Read,Glob,Grep,LS'],
    stdin: true,
    parser: 'claude-stream-json',
    modelArgs: ['--model', '{model}'],
    capabilities: { streaming: true, structured: true, resume: true, tools: true },
    verified: true,
    source: 'claude --help（本机 2.1.278 实测）',
    note: '提示词走 stdin。需要写文件时在节点 config.allowedTools 里放开 Write/Edit。',
  },

  /* ---------------------------------------------------------------- *
   * Codex CLI —— 官方文档；--json 事件结构 2025 年后改为 thread/turn/item
   * ---------------------------------------------------------------- */
  {
    kind: 'codex',
    label: 'Codex CLI',
    bin: 'codex',
    args: ['exec', '--json', '--skip-git-repo-check', '{prompt}'],
    parser: 'codex-json',
    modelArgs: ['-m', '{model}'],
    capabilities: { streaming: true, structured: false, resume: false, tools: true },
    verified: false,
    source: 'developers.openai.com/codex/cli — codex exec --json',
    note: '事件为 thread.started / turn.completed / item.completed(/agent_message) / token_count。默认沙箱是只读，需要写盘加 --full-auto。',
  },

  /* ---------------------------------------------------------------- *
   * OpenCode
   * ---------------------------------------------------------------- */
  {
    kind: 'opencode',
    label: 'OpenCode',
    bin: 'opencode',
    args: ['run', '{prompt}', '--format', 'json'],
    parser: 'opencode-json',
    modelArgs: ['-m', '{model}'],
    capabilities: { streaming: true, structured: false, resume: true, tools: true },
    verified: false,
    source: 'opencode.ai/docs/cli — opencode run --format json（NDJSON）',
    note: '输出是 NDJSON：step_start / text / tool_use / step_finish / error。自动化环境需要 --dangerously-skip-permissions。',
  },

  /* ---------------------------------------------------------------- *
   * Qoder —— 接口刻意对齐 Claude Code
   * ---------------------------------------------------------------- */
  {
    kind: 'qoder',
    label: 'Qoder CLI',
    bin: 'qoder',
    args: ['-p', '--output-format', 'stream-json'],
    stdin: true,
    parser: 'claude-stream-json',
    modelArgs: ['-m', '{model}'],
    capabilities: { streaming: true, structured: true, resume: true, tools: true },
    verified: false,
    source: 'docs.qoder.com/cli/run-in-scripts',
    note: 'CLI 设计对齐 Claude Code：-p + --output-format stream-json，所以直接复用 Claude 的解析器。无头模式下需 --permission-mode accept_edits 才能改文件。',
  },

  /* ---------------------------------------------------------------- *
   * WorkBuddy（腾讯 CodeBuddy）
   * ---------------------------------------------------------------- */
  {
    kind: 'workbuddy',
    label: 'WorkBuddy',
    bin: 'codebuddy',
    args: ['-p', '--output-format', 'json'],
    stdin: true,
    parser: 'json-result',
    modelArgs: ['--model', '{model}'],
    capabilities: { streaming: false, structured: true, resume: false, tools: true },
    verified: false,
    source: 'npm @tencent-ai/codebuddy-code — codebuddy -p --output-format json',
    note: '可执行文件名是 codebuddy，不是 workbuddy。需要自动执行时加 --dangerously-skip-permissions。',
  },

  /* ---------------------------------------------------------------- *
   * Z Code（智谱 Z.ai）
   * ---------------------------------------------------------------- */
  {
    kind: 'zcode',
    label: 'Z Code',
    bin: 'zcode',
    args: ['--prompt', '{prompt}', '--mode', 'build', '--json'],
    parser: 'json-result',
    capabilities: { streaming: false, structured: true, resume: false, tools: true },
    verified: false,
    source: 'zcode.z.ai / github.com/zai-org/ZCode',
    note: '无头模式用 --prompt + --json；权限模式 plan（只读）/ build / edit / yolo。官方无 npm 包，通常需要从桌面端 resources 里链接出来。',
  },

  /* ---------------------------------------------------------------- *
   * Trae
   * ---------------------------------------------------------------- */
  {
    kind: 'trae',
    label: 'Trae CLI',
    bin: 'trae-cli',
    args: ['run', '{prompt}'],
    parser: 'plain',
    modelArgs: ['--model', '{model}'],
    capabilities: { streaming: false, structured: false, resume: false, tools: true },
    verified: false,
    source: 'github.com/bytedance/trae-agent — trae-cli run "<task>"',
    note: '注意有两个同名 CLI：开源 trae-cli（本预设）与商业版 traecli。商业版用 `traecli -- "<prompt>"`，改 bin/args 即可。',
  },

  /* ---------------------------------------------------------------- *
   * DeepSeek Harness
   * ---------------------------------------------------------------- */
  {
    kind: 'dsh',
    label: 'DeepSeek Harness',
    bin: 'dsh',
    args: ['--profile', 'headless', '--json'],
    stdin: true,
    parser: 'dsh-json',
    capabilities: { streaming: true, structured: true, resume: true, tools: true },
    verified: true,
    source:
      '本地仓库 apps/cli/README.md + packages/bundle/headless/src/json-stream.ts（本机 dsh 0.2.0-rc.2 实测）',
    note:
      '任务从 stdin 传入（省略位置参数时 dsh 读 stdin）。JSON 事件：session/text/tool_call/tool_result/final/error。' +
      '从源码跑用 bin=pnpm、args=["dsh","--profile","headless","--json"]，并在节点里用 config.cwd 指向仓库根目录。',
  },
];

export function findPreset(kind: string): CliAgentSpec | undefined {
  return CLI_PRESETS.find((p) => p.kind === kind);
}
