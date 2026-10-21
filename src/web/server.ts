/**
 * 可视化编排服务。
 *
 * 零依赖：只用 node:http。前端是单页 HTML + 原生 JS + SVG，不需要打包工具。
 *
 * 职责边界很清楚：
 *   - 它不实现任何编排逻辑，全部转交给 core/engine；
 *   - 它只是把「文件读写」和「事件流」暴露成 HTTP；
 *   - 运行状态通过 SSE 推给浏览器，因为工作流是长任务，轮询会很难看。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runWorkflow, validateSpec } from '../core/engine';
import { createDrivers } from '../registry';
import { listCliStatus } from '../drivers/cli';
import type { WorkflowEvent, WorkflowSpec } from '../core/types';

export interface WebOptions {
  /** 工作流 JSON 所在目录 */
  workflowsDir: string;
  /** 默认工作目录（工作流里没写 workdir 时用） */
  workdir: string;
  /** PlayfulCode 根目录 */
  playfulCodeRoot: string;
  host?: string;
  port?: number;
}

interface Session {
  events: WorkflowEvent[];
  subscribers: Set<http.ServerResponse>;
  done: boolean;
  /** 跑完之后把每个节点的产出留在这里，供前端按需拉取 */
  outputs?: Record<string, unknown>;
}

export function startWeb(opts: WebOptions): Promise<http.Server> {
  const sessions = new Map<string, Session>();
  const publicDir = resolvePublicDir();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const route = url.pathname;

    try {
      if (route === '/api/workflows' && req.method === 'GET') {
        return json(res, 200, {
          files: listWorkflows(opts.workflowsDir),
          agents: agentList(opts.playfulCodeRoot),
        });
      }

      if (route === '/api/workflow' && req.method === 'GET') {
        const file = safeName(url.searchParams.get('file'));
        return json(res, 200, readWorkflow(opts.workflowsDir, file));
      }

      if (route === '/api/workflow' && (req.method === 'PUT' || req.method === 'POST')) {
        const body = await readJson(req);
        const file = safeName(url.searchParams.get('file') ?? (body as { file?: string }).file ?? null);
        const { file: _ignored, ...rest } = body as WorkflowSpec & { file?: string };
        const spec = validateIncoming(rest);
        fs.writeFileSync(path.join(opts.workflowsDir, file), `${JSON.stringify(spec, null, 2)}\n`, 'utf8');
        return json(res, 200, { ok: true, file });
      }

      if (route === '/api/run' && req.method === 'POST') {
        const body = (await readJson(req)) as { spec?: WorkflowSpec; mock?: boolean };
        if (!body?.spec) return json(res, 400, { error: '缺少 spec' });

        const problems = validateSpec(body.spec);
        if (problems.length > 0) return json(res, 400, { error: problems.join('；') });

        const sessionId = randomUUID();
        const session: Session = { events: [], subscribers: new Set(), done: false };
        sessions.set(sessionId, session);
        void execute(sessionId, session, body.spec, Boolean(body.mock), opts, () => {
          setTimeout(() => sessions.delete(sessionId), 60_000).unref?.();
        });
        return json(res, 200, { sessionId });
      }

      if (route === '/api/output' && req.method === 'GET') {
        const session = sessions.get(url.searchParams.get('session') ?? '');
        if (!session) return json(res, 404, { error: '会话不存在' });
        const nodeId = url.searchParams.get('node');
        const outputs = session.outputs ?? {};
        return json(res, 200, nodeId ? (outputs[nodeId] ?? null) : outputs);
      }

      if (route === '/api/events' && req.method === 'GET') {
        const sessionId = url.searchParams.get('session') ?? '';
        const session = sessions.get(sessionId);
        if (!session) return json(res, 404, { error: '会话不存在' });

        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        // 重放已发生的事件：浏览器可能比第一个事件晚到
        for (const e of session.events) res.write(`data: ${JSON.stringify(e)}\n\n`);
        if (session.done) {
          res.end();
          return;
        }
        session.subscribers.add(res);
        req.on('close', () => session.subscribers.delete(res));
        return;
      }

      // 静态文件
      return serveStatic(publicDir, route, res);
    } catch (err) {
      return json(res, 500, { error: (err as Error).message });
    }
  });

  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 3081;

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      // eslint-disable-next-line no-console
      console.log(`\n  编排界面：http://${host}:${port}\n  工作流目录：${opts.workflowsDir}\n`);
      resolve(server);
    });
  });
}

/* ------------------------------------------------------------------ *
 * 执行与事件分发
 * ------------------------------------------------------------------ */

async function execute(
  sessionId: string,
  session: Session,
  spec: WorkflowSpec,
  mock: boolean,
  opts: WebOptions,
  onDone: () => void,
): Promise<void> {
  const publish = (e: WorkflowEvent): void => {
    session.events.push(e);
    const payload = `data: ${JSON.stringify(e)}\n\n`;
    for (const sub of session.subscribers) sub.write(payload);
  };

  try {
    const drivers = createDrivers({ playfulCodeRoot: opts.playfulCodeRoot, mock });
    const workdir = spec.workdir ? path.resolve(opts.workdir, spec.workdir) : opts.workdir;
    const summary = await runWorkflow({ ...spec, workdir }, { drivers, workdir, emit: publish });
    session.outputs = summary.outputs;
    // 落一份到 runs/，网页跑的结果和命令行跑的一样可追溯
    writeWebRun(sessionId, summary);
  } catch (err) {
    publish({
      type: 'node_note',
      nodeId: '',
      level: 'error',
      message: (err as Error).message,
      at: Date.now(),
    });
    publish({ type: 'workflow_end', runId: sessionId, status: 'failed', ms: 0, at: Date.now() });
  } finally {
    session.done = true;
    for (const sub of session.subscribers) sub.end();
    session.subscribers.clear();
    // 给浏览器留一分钟取完结果，之后释放
    onDone();
  }
}

/** 把网页运行的产出写到 runs/web-<session>/，与命令行保持一致。 */
function writeWebRun(
  sessionId: string,
  summary: { runId: string; ms: number; usage: { totalTokens: number }; outputs: Record<string, unknown> },
): void {
  try {
    const dir = path.resolve('runs', `web-${sessionId.slice(0, 8)}`);
    fs.mkdirSync(dir, { recursive: true });
    type Out = { nodeId: string; agent: string; status: string; text: string };
    const lines = Object.values(summary.outputs as Record<string, Out>).map(
      (o) => `# ${o.nodeId} (${o.agent}) — ${o.status}\n\n${o.text}\n`,
    );
    fs.writeFileSync(path.join(dir, 'outputs.md'), lines.join('\n---\n'), 'utf8');
    fs.writeFileSync(
      path.join(dir, 'meta.json'),
      JSON.stringify({ runId: summary.runId, ms: summary.ms, tokens: summary.usage.totalTokens }, null, 2),
      'utf8',
    );
  } catch {
    /* 落盘失败不该影响运行 */
  }
}

/* ------------------------------------------------------------------ *
 * 工作流文件
 * ------------------------------------------------------------------ */

function listWorkflows(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
}

function readWorkflow(dir: string, file: string): WorkflowSpec {
  const full = path.join(dir, file);
  if (!fs.existsSync(full)) throw new Error(`工作流不存在：${file}`);
  return JSON.parse(fs.readFileSync(full, 'utf8')) as WorkflowSpec;
}

/** 只允许工作流目录下的 .json 文件名，挡住 ../ 穿越。 */
function safeName(raw: string | null): string {
  const name = (raw ?? '').trim();
  if (!name || name !== path.basename(name) || !/^[\w.-]+\.json$/.test(name)) {
    throw new Error(`非法的工作流文件名：${name || '(空)'}`);
  }
  return name;
}

function validateIncoming(body: unknown): WorkflowSpec {
  const spec = body as WorkflowSpec;
  if (!spec || typeof spec !== 'object' || !Array.isArray(spec.nodes)) {
    throw new Error('工作流格式错误：缺少 nodes 数组');
  }
  const problems = validateSpec(spec);
  if (problems.length > 0) throw new Error(problems.join('；'));
  return spec;
}

/**
 * 面板里展示的是「真实 Driver 的能力」而不是 Mock 的，
 * 否则用户会看到平台能力标注错误（比如 PlayfulCode 明明有工具却显示 tools:false）。
 * PlayfulCode 没构建好时退回 Mock，界面仍然可用。
 */
function agentList(pcRoot: string): { kind: string; capabilities: Record<string, unknown> }[] {
  let drivers;
  try {
    drivers = createDrivers({ playfulCodeRoot: pcRoot });
  } catch {
    drivers = createDrivers({ playfulCodeRoot: '', mock: true });
  }
  const status = new Map(listCliStatus().map((s) => [s.kind, s]));
  return Object.entries(drivers).map(([kind, d]) => {
    const s = status.get(kind);
    // 内置 Agent 的可用性：playfulcode 依赖 PC_ROOT，其余恒可用
    const builtinAvailable = kind !== 'playfulcode' || Boolean(pcRoot);
    return {
      kind,
      label: s?.label ?? kind,
      capabilities: d.capabilities as unknown as Record<string, unknown>,
      available: s ? s.available : builtinAvailable,
      verified: s?.verified ?? true,
      ...(s?.note ? { note: s.note } : {}),
      ...(kind === 'playfulcode' && !pcRoot
        ? { note: '未配置 PC_ROOT；可改用 claude / dsh，或在 .env 里指定 PlayfulCode 路径。' }
        : {}),
    };
  });
}

/* ------------------------------------------------------------------ *
 * HTTP 小工具
 * ------------------------------------------------------------------ */

function json(res: http.ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(text);
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 5 * 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (err) {
        reject(new Error(`请求体不是合法 JSON：${(err as Error).message}`));
      }
    });
    req.on('error', reject);
  });
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function serveStatic(dir: string, route: string, res: http.ServerResponse): void {
  const rel = route === '/' ? 'index.html' : route.replace(/^\/+/, '');
  const full = path.join(dir, rel);
  // 防止 ../ 越出 public 目录
  if (!full.startsWith(dir) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    json(res, 404, { error: 'Not found' });
    return;
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(full)] ?? 'application/octet-stream',
    // 演示时会反复改样式，别让浏览器拿缓存
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(full).pipe(res);
}

/** 构建后 public 会被复制到 dist/web/public；开发时回退到源码目录。 */
function resolvePublicDir(): string {
  const built = path.join(__dirname, 'public');
  if (fs.existsSync(path.join(built, 'index.html'))) return built;
  return path.resolve(__dirname, '../../src/web/public');
}
