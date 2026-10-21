/**
 * 各平台输出的解析器。
 *
 * 这是整个多平台接入里唯一真正「平台相关」的地方：
 * 把各家形态不同的事件流，翻译成同一套 DriverEvent。
 * 加平台时优先复用已有解析器，实在不一样再加一个。
 *
 * 所有解析器都必须容忍：空行、非 JSON 行、未知事件类型、字段缺失。
 * 输出格式随版本变化是常态，能继续跑比严格报错更重要。
 */

import type { DriverEvent } from '../../core/types';
import type { LineParser, ParseState } from './types';

const asObject = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;

const asString = (v: unknown): string => (typeof v === 'string' ? v : '');

const asNumber = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/* ------------------------------------------------------------------ *
 * Claude Code：--output-format stream-json
 *   {"type":"system","subtype":"init","session_id":"…"}
 *   {"type":"assistant","message":{"content":[{"type":"text","text":"…"}]}}
 *   {"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"…"}]}}
 *   {"type":"result","subtype":"success","result":"…","usage":{…}}
 * ------------------------------------------------------------------ */

/**
 * tool_use 事件带名字，tool_result 只带 id，所以要把 id→name 记住，
 * 否则工具结束事件里名字是空的，界面上会显示成「✓  0ms」。
 */
const toolNames = new WeakMap<object, Map<string, string>>();

function remember(state: object, id: string, name: string): void {
  let m = toolNames.get(state);
  if (!m) {
    m = new Map();
    toolNames.set(state, m);
  }
  m.set(id, name);
}

function nameFor(state: object, id: string): string {
  return toolNames.get(state)?.get(id) ?? '';
}

export const claudeStreamJson: LineParser = (line, state, emit) => {
  const raw = line.trim();
  if (!raw.startsWith('{')) return;

  let ev: Record<string, unknown>;
  try {
    ev = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return;
  }

  switch (asString(ev['type'])) {
    case 'system':
      if (ev['subtype'] === 'init' && asString(ev['session_id'])) {
        state.sessionId = asString(ev['session_id']);
      }
      break;

    case 'assistant': {
      const content = asObject(ev['message'])?.['content'];
      if (!Array.isArray(content)) break;
      for (const rawBlock of content) {
        const b = asObject(rawBlock);
        if (!b) continue;
        if (b['type'] === 'text' && b['text']) {
          const text = asString(b['text']);
          state.chunks.push(text);
          emit({ kind: 'text', delta: text });
        } else if (b['type'] === 'tool_use' && b['id'] && b['name']) {
          const id = asString(b['id']);
          const name = asString(b['name']);
          state.toolsUsed.push(name);
          remember(state, id, name);
          emit({ kind: 'tool_start', id, name, args: asObject(b['input']) ?? {} });
        }
      }
      break;
    }

    case 'user': {
      const content = asObject(ev['message'])?.['content'];
      if (!Array.isArray(content)) break;
      for (const rawBlock of content) {
        const b = asObject(rawBlock);
        if (!b || b['type'] !== 'tool_result') continue;
        const id = asString(b['tool_use_id']);
        emit({ kind: 'tool_end', id, name: nameFor(state, id), ok: !b['is_error'], ms: 0 });
      }
      break;
    }

    case 'result': {
      if (typeof ev['result'] === 'string') state.finalText = ev['result'];
      if (ev['is_error']) state.error = asString(ev['result']) || '执行失败';
      state.sessionId = asString(ev['session_id']) || state.sessionId;
      state.stopReason = asString(ev['subtype']);
      const u = asObject(ev['usage']);
      if (u) {
        const input = asNumber(u['input_tokens']);
        const output = asNumber(u['output_tokens']);
        state.usage = { promptTokens: input, completionTokens: output, totalTokens: input + output };
        emit({ kind: 'usage', usage: state.usage });
      }
      break;
    }

    default:
      break;
  }
};

/* ------------------------------------------------------------------ *
 * Codex：codex exec --json
 *
 * 当前事件结构：
 *   {"type":"thread.started","thread_id":"…"}
 *   {"type":"turn.completed","usage":{"input_tokens":…,"output_tokens":…}}
 *   {"type":"item.started","item":{"type":"command_execution","command":"…"}}
 *   {"type":"item.completed","item":{"type":"agent_message","text":"…"}}
 *   {"type":"token_count",…} / {"type":"error","message":"…"}
 *
 * 旧结构（部分版本仍在用）：
 *   {"id":"0","msg":{"type":"agent_message","message":"…"}}
 *
 * 两种都兼容，免得换个版本整个节点就挂掉。
 * ------------------------------------------------------------------ */

export const codexJson: LineParser = (line, state, emit) => {
  const raw = line.trim();
  if (!raw.startsWith('{')) return;

  let ev: Record<string, unknown>;
  try {
    ev = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return;
  }

  const msg = asObject(ev['msg']);
  const type = asString(ev['type']) || asString(msg?.['type']);

  switch (type) {
    case 'thread.started': {
      const id = asString(ev['thread_id']);
      if (id) state.sessionId = id;
      break;
    }

    case 'turn.completed': {
      const u = asObject(ev['usage']);
      if (u) {
        const input = asNumber(u['input_tokens']);
        const output = asNumber(u['output_tokens']);
        state.usage = { promptTokens: input, completionTokens: output, totalTokens: input + output };
        emit({ kind: 'usage', usage: state.usage });
      }
      state.stopReason = 'turn.completed';
      break;
    }

    case 'item.started':
    case 'item.updated':
    case 'item.completed': {
      const item = asObject(ev['item']);
      if (!item) break;
      const itemType = asString(item['type']);

      if (itemType === 'agent_message') {
        const text = asString(item['text']);
        if (text) {
          state.chunks.push(text);
          state.finalText = text;
          emit({ kind: 'text', delta: text });
        }
      } else if (itemType === 'command_execution') {
        const id = asString(item['id']);
        const command = asString(item['command']) || 'shell';
        if (type === 'item.started') {
          state.toolsUsed.push('shell');
          emit({ kind: 'tool_start', id, name: 'shell', args: { command } });
        } else if (type === 'item.completed') {
          emit({ kind: 'tool_end', id, name: 'shell', ok: item['exit_code'] === 0 || item['exit_code'] === undefined, ms: 0 });
        }
      }
      break;
    }

    case 'token_count': {
      const info = asObject(ev['info']);
      const u = asObject(info?.['last_token_usage']) ?? msg;
      if (u) {
        const input = asNumber(u['input_tokens']);
        const output = asNumber(u['output_tokens']);
        state.usage = {
          promptTokens: input,
          completionTokens: output,
          totalTokens: asNumber(u['total_tokens']) || input + output,
        };
        emit({ kind: 'usage', usage: state.usage });
      }
      break;
    }

    // 旧事件结构
    case 'agent_message':
    case 'task_complete': {
      const text = asString(msg?.['message']) || asString(msg?.['last_agent_message']);
      if (text) {
        state.chunks.push(text);
        state.finalText = text;
        emit({ kind: 'text', delta: text });
      }
      break;
    }

    // 更早的事件结构：exec_command_begin/end
    case 'exec_command_begin': {
      const cmd = Array.isArray(msg?.['command']) ? (msg!['command'] as string[]).join(' ') : 'shell';
      const id = String(ev['id'] ?? '');
      state.toolsUsed.push('shell');
      emit({ kind: 'tool_start', id, name: 'shell', args: { command: cmd } });
      break;
    }

    case 'exec_command_end': {
      emit({ kind: 'tool_end', id: String(ev['id'] ?? ''), name: 'shell', ok: !msg?.['exit_code'], ms: 0 });
      break;
    }

    case 'error': {
      const errObj = asObject(ev['error']);
      state.error = asString(ev['message']) || asString(errObj?.['message']) || '执行失败';
      break;
    }

    default:
      break;
  }
};

/* ------------------------------------------------------------------ *
 * OpenCode：opencode run --format json（NDJSON）
 *   {"type":"step_start","sessionID":"ses_…"}
 *   {"type":"text","part":{"text":"…"}}
 *   {"type":"tool_use","part":{"tool":"bash","state":{"status":"completed"}}}
 *   {"type":"step_finish","part":{"reason":"stop","tokens":{…}}}
 *   {"type":"error","error":{"data":{"message":"…"}}}
 *
 * text 事件给的是完整片段而非增量，直接拼接即可。
 * ------------------------------------------------------------------ */

export const opencodeJson: LineParser = (line, state, emit) => {
  const raw = line.trim();
  if (!raw.startsWith('{')) return;

  let ev: Record<string, unknown>;
  try {
    ev = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return;
  }

  const part = asObject(ev['part']);

  switch (asString(ev['type'])) {
    case 'step_start': {
      const sid = asString(ev['sessionID']);
      if (sid) state.sessionId = sid;
      break;
    }

    case 'text': {
      const text = asString(part?.['text']);
      if (text) {
        state.chunks.push(text);
        state.finalText = state.chunks.join('');
        emit({ kind: 'text', delta: text });
      }
      break;
    }

    case 'tool_use': {
      const tool = asString(part?.['tool']) || 'tool';
      const st = asObject(part?.['state']);
      const status = asString(st?.['status']);
      const id = asString(part?.['callID']) || asString(part?.['id']) || tool;
      if (status === 'completed' || status === 'error') {
        emit({ kind: 'tool_end', id, name: tool, ok: status === 'completed', ms: 0 });
      } else {
        state.toolsUsed.push(tool);
        emit({ kind: 'tool_start', id, name: tool, args: {} });
      }
      break;
    }

    case 'step_finish': {
      const tokens = asObject(part?.['tokens']);
      const input = asNumber(tokens?.['input']);
      const output = asNumber(tokens?.['output']);
      if (input || output) {
        state.usage = { promptTokens: input, completionTokens: output, totalTokens: input + output };
        emit({ kind: 'usage', usage: state.usage });
      }
      if (part?.['reason'] === 'stop') state.stopReason = 'stop';
      break;
    }

    case 'error': {
      const errObj = asObject(ev['error']);
      const data = asObject(errObj?.['data']);
      state.error = asString(data?.['message']) || asString(errObj?.['name']) || '执行失败';
      break;
    }

    default:
      break;
  }
};

/* ------------------------------------------------------------------ *
 * DeepSeek Harness：dsh --profile headless --json
 *
 * 事件直接取自 dsh 源码 `packages/bundle/headless/src/json-stream.ts`：
 *   {"type":"session","sessionId":"…","cwd":"…"}
 *   {"type":"status","phase":"turn_start"|"step_start"|"step_end"|"turn_end"}
 *   {"type":"thinking","text":"…"}      推理过程，不进答案
 *   {"type":"text","text":"…"}          助手正文
 *   {"type":"tool_call","callId":"…","tool":"…","input":{…}}
 *   {"type":"tool_result","callId":"…","status":"completed"|"error","result":"…"}
 *   {"type":"final","text":"…"}         终止事件，权威答案
 *   {"type":"error","message":"…"}
 * ------------------------------------------------------------------ */

export const dshJson: LineParser = (line, state, emit) => {
  const raw = line.trim();
  if (!raw.startsWith('{')) return;

  let ev: Record<string, unknown>;
  try {
    ev = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return;
  }

  switch (asString(ev['type'])) {
    case 'session': {
      const sid = asString(ev['sessionId']);
      if (sid) state.sessionId = sid;
      break;
    }

    case 'text': {
      const text = asString(ev['text']);
      if (text) {
        state.chunks.push(text);
        emit({ kind: 'text', delta: text });
      }
      break;
    }

    case 'tool_call': {
      const id = asString(ev['callId']);
      const tool = asString(ev['tool']) || 'tool';
      state.toolsUsed.push(tool);
      emit({ kind: 'tool_start', id, name: tool, args: asObject(ev['input']) ?? {} });
      break;
    }

    case 'tool_result': {
      emit({
        kind: 'tool_end',
        id: asString(ev['callId']),
        name: '',
        ok: ev['status'] === 'completed',
        ms: 0,
      });
      break;
    }

    case 'final': {
      const text = asString(ev['text']);
      if (text) state.finalText = text;
      state.stopReason = 'final';
      break;
    }

    case 'error': {
      state.error = asString(ev['message']) || '执行失败';
      break;
    }

    case 'status': {
      // step_end 上带用量（camelCase），turn_end 上带结束原因（对象）
      if (ev['phase'] === 'step_end') {
        const u = asObject(ev['usage']);
        if (u) {
          const input = asNumber(u['inputTokens']);
          const output = asNumber(u['outputTokens']);
          const total = asNumber(u['totalTokens']) || input + output;
          state.usage = {
            // dsh 的 totalTokens 是累计值，而 inputTokens 是单步增量，
            // 两者对不上时以 total 为准反推输入，避免界面上出现「输入+输出≠总量」
            promptTokens: total > input + output ? total - output : input,
            completionTokens: output,
            totalTokens: total,
          };
          emit({ kind: 'usage', usage: state.usage });
        }
      }
      if (ev['phase'] === 'turn_end') {
        const reason = ev['reason'];
        state.stopReason =
          typeof reason === 'string' ? reason : asString(asObject(reason)?.['kind']) || 'turn_end';
      }
      break;
    }

    default:
      break;
  }
};

/* ------------------------------------------------------------------ *
 * 通用 JSON 结果：整行一个对象的 { result | text | content, usage }
 * 适合 Qoder --output-format json、WorkBuddy、Z Code --json 这类一次性输出。
 * ------------------------------------------------------------------ */

export const jsonResult: LineParser = (line, state, emit) => {
  const raw = line.trim();
  if (!raw) return;
  if (!raw.startsWith('{')) {
    state.chunks.push(raw);
    emit({ kind: 'text', delta: `${raw}\n` });
    return;
  }

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return;
  }

  const text = pickString(obj, ['result', 'response', 'text', 'content', 'message', 'output']);
  if (text) {
    state.chunks.push(text);
    state.finalText = text;
    emit({ kind: 'text', delta: text });
  }

  const usage = asObject(obj['usage']);
  if (usage) {
    const input = asNumber(usage['input_tokens']) || asNumber(usage['prompt_tokens']);
    const output = asNumber(usage['output_tokens']) || asNumber(usage['completion_tokens']);
    state.usage = {
      promptTokens: input,
      completionTokens: output,
      totalTokens: asNumber(usage['total_tokens']) || input + output,
    };
    emit({ kind: 'usage', usage: state.usage });
  }

  const sid = obj['session_id'] ?? obj['sessionId'];
  if (typeof sid === 'string') state.sessionId = sid;

  const isError = obj['is_error'] ?? obj['error'];
  if (isError && typeof isError === 'string') state.error = isError;
};

/* ------------------------------------------------------------------ *
 * 纯文本：整行就是答案的一部分
 * ------------------------------------------------------------------ */

export const plainText: LineParser = (line, state, emit) => {
  state.chunks.push(line);
  emit({ kind: 'text', delta: `${line}\n` });
};

export const PARSERS: Record<string, LineParser> = {
  'claude-stream-json': claudeStreamJson,
  'codex-json': codexJson,
  'opencode-json': opencodeJson,
  'dsh-json': dshJson,
  'json-result': jsonResult,
  plain: plainText,
};

function pickString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v) return v;
  }
  return undefined;
}

export type { ParseState };
