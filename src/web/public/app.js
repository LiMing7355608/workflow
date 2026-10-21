/* 可视化编排编辑器。零依赖：原生 DOM + SVG。 */

'use strict';

const NODE_W = 236;
const NODE_H = 98;
const STEP_X = 300;   // 自动排布：每层水平间距
const STEP_Y = 132;   // 同层垂直间距
const PAD_X = 60;
const PAD_Y = 44;

/** 有官方标识的 Agent：图标来自 Lobe Icons，保留各自的品牌色 */
const AGENT_LOGO = {
  claude: 'claude.svg',
  dsh: 'dsh.svg',
  codex: 'codex.svg',
  opencode: 'opencode.svg',
  qoder: 'qoder.svg',
  workbuddy: 'workbuddy.svg',
  trae: 'trae.svg',
  zcode: 'zcode.svg',
};

/** 没有公开标识的用缩写 + 形状，颜色取项目自己的强调色 */
const AGENT_MONOGRAM = {
  playfulcode: { text: 'P', shape: 'circle', color: '#44618A' },
  'fn:scan': { text: 'S', shape: 'square', color: '#A9762F' },
  mock: { text: 'M', shape: 'dashed', color: '#6E7580' },
};

const LOGO_SIZE = 62;

function logoMarkup(kind) {
  const x = NODE_W - LOGO_SIZE - 10;
  const y = (NODE_H - LOGO_SIZE) / 2;
  const file = AGENT_LOGO[kind];

  if (file) {
    return `<image class="agent-logo" href="/logos/${file}" x="${x}" y="${y}" width="${LOGO_SIZE}" height="${LOGO_SIZE}" preserveAspectRatio="xMidYMid meet"></image>`;
  }

  const mono =
    AGENT_MONOGRAM[kind] ?? { text: String(kind).slice(0, 2).toUpperCase(), shape: 'square', color: '#6E7580' };
  const color = mono.color ?? '#6E7580';
  const r = mono.shape === 'square' ? 4 : LOGO_SIZE / 2;
  const dash = mono.shape === 'dashed' ? ' stroke-dasharray="5 4"' : '';
  const fontSize = mono.text.length > 1 ? 20 : 26;

  return `<g class="agent-logo" transform="translate(${x} ${y})">
    <rect x="1" y="1" width="${LOGO_SIZE - 2}" height="${LOGO_SIZE - 2}" rx="${r}" fill="none" stroke="${color}" stroke-width="2"${dash}></rect>
    <text x="${LOGO_SIZE / 2}" y="${LOGO_SIZE / 2 + fontSize / 3}" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="${fontSize}" fill="${color}">${esc(mono.text)}</text>
  </g>`;
}

const EMPTY_LOG = '<div class="dim" style="font-style:italic">尚未运行。点右上角「运行」开始。</div>';

const S = {
  file: '',
  spec: null,
  agents: [],
  selected: null,
  view: { x: 60, y: 40, k: 1 },
  status: {},      // nodeId -> running | ok | skipped | failed
  outputs: {},     // nodeId -> 运行结束后的完整产出
  live: {},        // nodeId -> 运行中的流式正文
  session: '',     // 当前运行的会话 id
  dirty: false,
  running: false,
  es: null,
};

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */

async function boot() {
  const meta = await fetch('/api/workflows').then((r) => r.json());
  S.agents = meta.agents;
  $('file').innerHTML = meta.files.map((f) => `<option>${esc(f)}</option>`).join('');
  // ?file=xxx.json 可直接打开指定工作流
  const want = new URLSearchParams(location.search).get('file');
  const first = want && meta.files.includes(want) ? want : meta.files[0];
  $('file').value = first ?? '';
  if (first) await loadWorkflow(first);

  $('file').onchange = (e) => loadWorkflow(e.target.value);
  $('new').onclick = addNode;
  $('layout').onclick = autoLayout;
  $('save').onclick = save;
  $('run').onclick = run;
  $('clear').onclick = () => { $('log').innerHTML = ''; $('usage').textContent = ''; };

  bindCanvas();
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(fitView, 150);
  });
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(); }
    if (e.key === 'Delete' && S.selected && document.activeElement === document.body) {
      deleteNode(S.selected);
    }
  });
  window.addEventListener('beforeunload', (e) => {
    if (S.dirty) { e.preventDefault(); e.returnValue = ''; }
  });

  // ?select=<id> —— 直接选中某个节点，方便分享定位
  const pick = new URLSearchParams(location.search).get('select');
  if (pick && nodeById(pick)) { S.selected = pick; render(); renderPanel(); }

  // ?autorun=mock —— 打开即跑一遍模拟，便于演示与截图分享
  const auto = new URLSearchParams(location.search).get('autorun');
  if (auto) {
    $('mock').checked = auto === 'mock';
    await run();
  }
}

async function loadWorkflow(file) {
  S.file = file;
  S.spec = await fetch(`/api/workflow?file=${encodeURIComponent(file)}`).then((r) => r.json());
  S.selected = null;
  S.status = {};
  S.dirty = false;
  ensurePositions();
  fitView();
  renderPanel();
  updateDirty();
}

/* ------------------------------------------------------------------ *
 * 数据操作
 * ------------------------------------------------------------------ */

const nodes = () => S.spec.nodes;
const nodeById = (id) => nodes().find((n) => n.id === id);

function ensurePositions() {
  const missing = nodes().filter((n) => !n.ui);
  if (missing.length === 0) return;
  const cols = {};
  for (const n of missing) {
    const depth = depthOf(n.id);
    cols[depth] = (cols[depth] ?? 0) + 1;
    n.ui = { x: PAD_X + depth * STEP_X, y: PAD_Y + (cols[depth] - 1) * STEP_Y };
  }
}

function depthOf(id, seen = new Set()) {
  if (seen.has(id)) return 0;
  seen.add(id);
  const n = nodeById(id);
  const deps = n?.dependsOn ?? [];
  return deps.length === 0 ? 0 : 1 + Math.max(...deps.map((d) => depthOf(d, seen)));
}

function addNode() {
  const used = new Set(nodes().map((n) => n.id));
  let i = 1;
  while (used.has(`node${i}`)) i++;
  const id = `node${i}`;
  const cx = (300 - S.view.x) / S.view.k;
  const cy = (200 - S.view.y) / S.view.k;
  nodes().push({
    id,
    agent: S.agents[0]?.kind ?? 'playfulcode',
    prompt: '',
    ui: { x: Math.round(cx), y: Math.round(cy) },
  });
  S.selected = id;
  changed();
}

function deleteNode(id) {
  const n = nodeById(id);
  if (!n) return;
  if (!confirm(`删除节点 ${id}？下游对它的依赖也会一并移除。`)) return;
  S.spec.nodes = nodes().filter((x) => x.id !== id);
  for (const other of nodes()) {
    if (other.dependsOn) {
      other.dependsOn = other.dependsOn.filter((d) => d !== id);
      if (other.dependsOn.length === 0) delete other.dependsOn;
    }
  }
  if (S.selected === id) S.selected = null;
  changed();
}

function addDependency(from, to) {
  if (from === to) return;
  const target = nodeById(to);
  if (!target) return;
  target.dependsOn = [...(target.dependsOn ?? [])];
  if (target.dependsOn.includes(from)) return;
  if (createsCycle(from, to)) {
    banner(`不能建立 ${from} → ${to}：会形成环`);
    return;
  }
  target.dependsOn.push(from);
  changed();
}

function createsCycle(from, to) {
  // 若 from 已经（间接）依赖 to，则 to 依赖 from 会成环
  const stack = [from];
  const seen = new Set();
  while (stack.length) {
    const cur = stack.pop();
    if (cur === to) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const d of nodeById(cur)?.dependsOn ?? []) stack.push(d);
  }
  return false;
}

function removeDependency(from, to) {
  const n = nodeById(to);
  if (!n?.dependsOn) return;
  n.dependsOn = n.dependsOn.filter((d) => d !== from);
  if (n.dependsOn.length === 0) delete n.dependsOn;
  changed();
}

function autoLayout() {
  const cols = {};
  for (const n of nodes()) {
    const depth = depthOf(n.id);
    cols[depth] = (cols[depth] ?? 0) + 1;
    n.ui = { x: PAD_X + depth * STEP_X, y: PAD_Y + (cols[depth] - 1) * STEP_Y };
  }
  changed();
  fitView();
}

/**
 * 让所有节点落进可视区。
 * 面板加宽后画布只剩一半宽，默认坐标很容易溢出，所以载入、
 * 自动排布和窗口尺寸变化时都重新适配一次。
 */
function fitView() {
  if (!S.spec || nodes().length === 0) return;
  const rect = $('canvas').getBoundingClientRect();
  if (!rect.width || !rect.height) return;

  const xs = nodes().map((n) => n.ui.x);
  const ys = nodes().map((n) => n.ui.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs) + NODE_W;
  const maxY = Math.max(...ys) + NODE_H;

  const pad = 64;
  const w = Math.max(1, maxX - minX);
  const h = Math.max(1, maxY - minY);
  const k = Math.max(0.4, Math.min(1, (rect.width - pad * 2) / w, (rect.height - pad * 2) / h));

  S.view.k = k;
  S.view.x = rect.width / 2 - ((minX + maxX) / 2) * k;
  S.view.y = rect.height / 2 - ((minY + maxY) / 2) * k;
  render();
}

function changed() {
  S.dirty = true;
  updateDirty();
  render();
  renderPanel();
}

/* ------------------------------------------------------------------ *
 * 渲染 SVG
 * ------------------------------------------------------------------ */

function render() {
  const vp = $('viewport');
  vp.setAttribute('transform', `translate(${S.view.x} ${S.view.y}) scale(${S.view.k})`);

  const parts = [];

  for (const n of nodes()) {
    for (const dep of n.dependsOn ?? []) {
      const a = nodeById(dep);
      if (!a) continue;
      parts.push(edgePath(a, n, `data-from="${esc(dep)}" data-to="${esc(n.id)}"`));
    }
  }

  for (const n of nodes()) {
    parts.push(nodeMarkup(n));
  }

  vp.innerHTML = parts.join('');
}

function edgePath(a, b, attrs) {
  const x1 = a.ui.x + NODE_W;
  const y1 = a.ui.y + NODE_H / 2;
  const x2 = b.ui.x;
  const y2 = b.ui.y + NODE_H / 2;
  const dx = Math.max(50, Math.abs(x2 - x1) / 2);
  const d = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
  return `<path class="edge" d="${d}" ${attrs}><title>点击删除这条依赖</title></path>`;
}

function nodeMarkup(n) {
  const st = S.status[n.id] ?? '';
  const cls = ['node', S.selected === n.id ? 'selected' : '', st].filter(Boolean).join(' ');
  const agent = esc(n.agent);
  const title = esc(n.id);
  const cond = n.when ? ` · 条件` : '';
  const loop = n.forEach ? ` · 循环` : '';
  const meta = S.agents.find((a) => a.kind === n.agent);
  const missing = meta && meta.available === false ? ' · 未安装' : '';
  const sub = esc(`${n.agent}${cond}${loop}${missing}`);

  return `
    <g class="${cls}" data-id="${esc(n.id)}" transform="translate(${n.ui.x} ${n.ui.y})">
      <rect class="body" width="${NODE_W}" height="${NODE_H}" rx="2"></rect>
      ${logoMarkup(n.agent)}
      <circle class="badge-dot" cx="${NODE_W - 16}" cy="16" r="3.5"></circle>
      <text class="title" x="16" y="32">${title}</text>
      <text class="sub" x="16" y="54">${sub}</text>
      <text class="prompt-preview" x="16" y="76">${esc(preview(n.prompt))}</text>
      <circle class="port port-in" cx="0" cy="${NODE_H / 2}" r="6" data-port="in" data-id="${esc(n.id)}"></circle>
      <circle class="port port-out" cx="${NODE_W}" cy="${NODE_H / 2}" r="6" data-port="out" data-id="${esc(n.id)}"></circle>
    </g>`;
}

function preview(text) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  const max = 12;
  return flat.length > max ? `${flat.slice(0, max)}…` : (flat || '（未填写提示词）');
}

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ------------------------------------------------------------------ *
 * 画布交互
 * ------------------------------------------------------------------ */

function bindCanvas() {
  const svg = $('canvas');
  let drag = null;

  svg.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    // 阻止默认的文本选择行为；否则拖动时浏览器会把整个画布当成可选中文本
    e.preventDefault();

    const portOut = e.target.closest('.port-out');
    const nodeEl = e.target.closest('.node');
    const edgeEl = e.target.closest('.edge');

    if (edgeEl && !S.running) {
      removeDependency(edgeEl.dataset.from, edgeEl.dataset.to);
      return;
    }

    if (portOut) {
      const from = portOut.dataset.id;
      const a = nodeById(from);
      drag = { type: 'edge', from, start: a.ui };
      return;
    }

    if (nodeEl) {
      const id = nodeEl.dataset.id;
      S.selected = id;
      const n = nodeById(id);
      drag = { type: 'node', id, dx: e.clientX, dy: e.clientY, ox: n.ui.x, oy: n.ui.y };
      render();
      renderPanel();
      return;
    }

    drag = { type: 'pan', x: e.clientX, y: e.clientY, ox: S.view.x, oy: S.view.y };
    svg.classList.add('panning');
  });

  window.addEventListener('mousemove', (e) => {
    if (!drag) return;

    if (drag.type === 'node') {
      const n = nodeById(drag.id);
      n.ui.x = Math.round(drag.ox + (e.clientX - drag.dx) / S.view.k);
      n.ui.y = Math.round(drag.oy + (e.clientY - drag.dy) / S.view.k);
      S.dirty = true;
      updateDirty();
      render();
      return;
    }

    if (drag.type === 'pan') {
      S.view.x = drag.ox + (e.clientX - drag.x);
      S.view.y = drag.oy + (e.clientY - drag.y);
      render();
      return;
    }

    if (drag.type === 'edge') {
      const p = toWorld(e);
      const a = nodeById(drag.from);
      const x1 = a.ui.x + NODE_W;
      const y1 = a.ui.y + NODE_H / 2;
      const dx = Math.max(50, Math.abs(p.x - x1) / 2);
      const path = document.getElementById('temp-edge');
      const d = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${p.x - dx} ${p.y}, ${p.x} ${p.y}`;
      if (path) path.setAttribute('d', d);
      else {
        const el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        el.id = 'temp-edge';
        el.setAttribute('class', 'edge temp');
        el.setAttribute('d', d);
        $('viewport').appendChild(el);
      }
    }
  });

  window.addEventListener('mouseup', (e) => {
    if (!drag) return;

    if (drag.type === 'edge') {
      document.getElementById('temp-edge')?.remove();
      const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('.node');
      if (target) addDependency(drag.from, target.dataset.id);
    }

    if (drag.type === 'pan') $('canvas').classList.remove('panning');
    drag = null;
  });

  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = toWorld(e);
    const k = Math.min(2, Math.max(0.35, S.view.k * (e.deltaY < 0 ? 1.1 : 0.9)));
    S.view.x = e.clientX - p.x * k;
    S.view.y = e.clientY - p.y * k;
    S.view.k = k;
    render();
  }, { passive: false });
}

function toWorld(e) {
  const rect = $('canvas').getBoundingClientRect();
  return {
    x: (e.clientX - rect.left - S.view.x) / S.view.k,
    y: (e.clientY - rect.top - S.view.y) / S.view.k,
  };
}

/* ------------------------------------------------------------------ *
 * 属性面板
 * ------------------------------------------------------------------ */

let panelFor = null;

function renderPanel() {
  const n = S.selected ? nodeById(S.selected) : null;
  const panel = $('panel');

  if (!n) {
    panelFor = null;
    panel.innerHTML = '<div class="empty">选中一个节点以编辑</div>';
    return;
  }

  // 只在切换节点或结构变化时重建，避免输入时丢焦点
  if (panelFor === n.id && panel.querySelector('[data-f="id"]')) {
    const idInput = panel.querySelector('[data-f="id"]');
    if (document.activeElement !== idInput) idInput.value = n.id;
    updateOutput();
    return;
  }
  panelFor = n.id;

  const agent = S.agents.find((a) => a.kind === n.agent);
  const caps = agent ? capsMarkup(agent) : '';
  const op = n.when?.op ?? '';
  const depList = (n.dependsOn ?? []).join(', ') || '（无）';

  panel.innerHTML = `
    <div class="field">
      <label>运行结果</label>
      <pre class="output" data-f="output"></pre>
      <div class="output-bar">
        <span class="help" data-f="output-meta"></span>
        <button class="tiny" data-act="copy-output">复制</button>
      </div>
    </div>

    <div class="field">
      <label>节点 ID</label>
      <input data-f="id" value="${esc(n.id)}" />
      <div class="help">上游依赖：${esc(depList)}</div>
    </div>

    <div class="field">
      <label>Agent</label>
      <select data-f="agent">
        ${S.agents
          .map((a) => {
            const off = a.available === false;
            const label = `${a.label ?? a.kind}${off ? '（未安装）' : ''}`;
            return `<option value="${esc(a.kind)}" ${a.kind === n.agent ? 'selected' : ''}>${esc(label)}</option>`;
          })
          .join('')}
        ${S.agents.some((a) => a.kind === n.agent) ? '' : `<option selected>${esc(n.agent)}</option>`}
      </select>
      ${caps}
      ${agent?.note ? `<div class="help">${esc(agent.note)}</div>` : ''}
    </div>

    <div class="field">
      <label>提示词</label>
      <textarea data-f="prompt" placeholder="用 {{上游节点.text}} 引用上游产出">${esc(n.prompt ?? '')}</textarea>
      <div class="help">支持 {{节点id.text}} · {{节点id.data.x}} · {{input.键}} · {{item}}</div>
    </div>

    <div class="field">
      <label>系统提示词</label>
      <textarea data-f="systemPrompt" style="min-height:60px">${esc(n.systemPrompt ?? '')}</textarea>
    </div>

    <div class="field">
      <label>最大步数</label>
      <input data-f="maxSteps" type="number" min="1" value="${n.maxSteps ?? ''}" placeholder="默认" />
    </div>

    <div class="field">
      <label>条件（不满足则跳过）</label>
      <div class="row">
        <input data-f="when.path" placeholder="scan.data.count" value="${esc(n.when?.path ?? '')}" />
        <select data-f="when.op">
          <option value="">无</option>
          ${['gt', 'gte', 'lt', 'lte', 'eq', 'ne', 'exists', 'empty']
            .map((o) => `<option value="${o}" ${op === o ? 'selected' : ''}>${o}</option>`)
            .join('')}
        </select>
      </div>
      <input data-f="when.value" style="margin-top:6px" placeholder="比较值（exists/empty 可留空）" value="${n.when?.value ?? ''}" />
    </div>

    <div class="field">
      <label>循环（对数组逐项执行）</label>
      <input data-f="forEach.over" placeholder="scan.data.findings" value="${esc(n.forEach?.over ?? '')}" />
      <div class="help">填写后该节点会用 {{item}} 逐项运行</div>
    </div>

    <button class="danger" data-act="delete">删除节点</button>
  `;

  panel.querySelectorAll('[data-f]').forEach((el) => {
    el.addEventListener('change', () => applyField(el));
    if (el.tagName === 'TEXTAREA') el.addEventListener('input', () => applyField(el, true));
  });
  panel.querySelector('[data-act="delete"]').onclick = () => deleteNode(n.id);
  panel.querySelector('[data-act="copy-output"]').onclick = () => {
    const text = panel.querySelector('[data-f="output"]').textContent ?? '';
    navigator.clipboard?.writeText(text);
  };
  updateOutput();
}

/**
 * 把选中节点的产出渲染到面板。
 * 优先用运行结束后的权威结果；没有就显示运行中的流式正文。
 */
function updateOutput() {
  const panel = $('panel');
  const pre = panel.querySelector('[data-f="output"]');
  const meta = panel.querySelector('[data-f="output-meta"]');
  if (!pre || !meta || !S.selected) return;

  const out = S.outputs[S.selected];
  const live = S.live[S.selected];

  if (out) {
    pre.textContent = out.text || '（空）';
    const tokens = out.usage?.totalTokens ?? 0;
    meta.textContent = `${out.status} · ${out.steps} 步 · ${tokens} tokens · ${out.ms}ms`;
    pre.dataset.state = out.status;
  } else if (live) {
    pre.textContent = live;
    meta.textContent = '运行中…';
    pre.dataset.state = 'running';
  } else {
    pre.textContent = '';
    meta.textContent = S.running ? '尚未产出' : '尚未运行';
    delete pre.dataset.state;
  }
}

function capsMarkup(agent) {
  const c = agent.capabilities ?? {};
  const item = (label, v) => {
    const cls = v === true ? 'cap on' : v === 'partial' ? 'cap partial' : 'cap';
    return `<span class="${cls}">${label}</span>`;
  };
  const badge =
    agent.available === false
      ? '<span class="cap off">未安装</span>'
      : agent.verified === false
        ? '<span class="cap partial">未实测</span>'
        : '';
  return `<div class="caps">
    ${item('流式', c.streaming)}${item('结构化', c.structured)}${item('续跑', c.resume)}${item('工具', c.tools)}${badge}
  </div>`;
}

function applyField(el, silent) {
  const n = nodeById(S.selected);
  if (!n) return;
  const path = el.dataset.f;
  const raw = el.value;

  if (path === 'id') {
    const next = raw.trim();
    if (!/^[A-Za-z0-9_-]+$/.test(next)) { banner('节点 ID 只允许字母、数字、下划线、连字符'); el.value = n.id; return; }
    if (next !== n.id && nodeById(next)) { banner(`ID ${next} 已存在`); el.value = n.id; return; }
    const old = n.id;
    const targets = nodes().filter((x) => (x.dependsOn ?? []).includes(old));
    n.id = next;
    for (const t of targets) t.dependsOn = t.dependsOn.map((d) => (d === old ? next : d));
    for (const t of nodes()) {
      if (t.prompt) t.prompt = t.prompt.split(`{{${old}.`).join(`{{${next}.`);
      if (t.systemPrompt) t.systemPrompt = t.systemPrompt.split(`{{${old}.`).join(`{{${next}.`);
    }
    S.selected = next;
    panelFor = null;
    changed();
    return;
  }

  if (path === 'agent') {
    n.agent = raw;
    panelFor = null;
    changed();
    const a = S.agents.find((x) => x.kind === raw);
    if (a?.available === false) banner(`${a.label} 没有安装，运行时会失败。`);
    else banner('');
    return;
  }
  if (path === 'prompt') { n.prompt = raw; touch(silent); return; }
  if (path === 'systemPrompt') { n.systemPrompt = raw; touch(silent); return; }
  if (path === 'maxSteps') {
    if (raw === '') delete n.maxSteps; else n.maxSteps = Number(raw);
    touch(silent); return;
  }

  if (path === 'when.path' || path === 'when.op' || path === 'when.value') {
    const key = path.split('.')[1];
    n.when = { ...(n.when ?? { path: '', op: 'gt', value: undefined }) };
    n.when[key] = key === 'value' ? (raw === '' ? undefined : coerce(raw)) : raw;
    if (!n.when.path || !n.when.op) delete n.when;
    touch(silent); return;
  }

  if (path === 'forEach.over') {
    if (raw.trim() === '') delete n.forEach;
    else n.forEach = { over: raw.trim(), max: n.forEach?.max ?? 20 };
    touch(silent);
  }
}

function coerce(raw) {
  const num = Number(raw);
  return Number.isFinite(num) && raw.trim() !== '' ? num : raw;
}

function touch(silent) {
  S.dirty = true;
  updateDirty();
  if (!silent) { render(); renderPanel(); }
  else { render(); }
}

function updateDirty() {
  $('dirty').hidden = !S.dirty;
}

/* ------------------------------------------------------------------ *
 * 保存与运行
 * ------------------------------------------------------------------ */

async function save() {
  try {
    const spec = S.spec;
    const res = await fetch(`/api/workflow?file=${encodeURIComponent(S.file)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...spec, file: S.file }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? '保存失败');
    S.dirty = false;
    updateDirty();
    banner('');
    log('dim', `已保存 ${S.file}`);
  } catch (err) {
    banner(`保存失败：${err.message}`);
  }
}

async function run() {
  if (S.running) return;
  if (S.dirty) await save();

  S.status = {};
  S.outputs = {};
  S.live = {};
  render();
  $('log').innerHTML = '';
  setRunning(true);

  let res;
  let body;
  try {
    res = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spec: S.spec, mock: $('mock').checked }),
    });
    body = await res.json();
    if (!res.ok) throw new Error(body.error ?? '启动失败');
  } catch (err) {
    banner(`运行失败：${err.message}`);
    setRunning(false);
    return;
  }

  banner('');
  S.session = body.sessionId;
  S.es = new EventSource(`/api/events?session=${body.sessionId}`);
  S.es.onmessage = (m) => handleEvent(JSON.parse(m.data));
  S.es.onerror = () => { S.es?.close(); setRunning(false); };
}

function handleEvent(e) {
  switch (e.type) {
    case 'workflow_start':
      log('dim', `▶ ${e.name} · ${e.nodes} 个节点 · ${e.runId}`);
      break;

    case 'node_start':
      S.status[e.nodeId] = 'running';
      S.live[e.nodeId] = '';
      delete S.outputs[e.nodeId];
      render();
      if (S.selected === e.nodeId) updateOutput();
      log('warn', `⚙ ${e.nodeId} [${e.agent}]${e.consumes?.length ? ` ← ${e.consumes.join(', ')}` : ''}`);
      break;

    case 'node_tool':
      if (e.phase === 'end') log(e.ok ? 'ok' : 'fail', `   ${e.ok ? '✓' : '✗'} ${e.name} ${e.ms ?? 0}ms`);
      break;

    case 'node_retry':
      log('warn', `   ↻ 重试 ${e.attempt}（${e.delayMs}ms）：${e.reason}`);
      break;

    case 'node_note':
      if (e.level === 'error' || e.level === 'warn') log(e.level === 'error' ? 'fail' : 'warn', `   ${e.message}`);
      break;

    case 'node_skip':
      S.status[e.nodeId] = 'skipped';
      render();
      log('dim', `   ⊘ ${e.nodeId} 跳过：${e.reason}`);
      break;

    case 'node_text':
      S.live[e.nodeId] = (S.live[e.nodeId] ?? '') + e.delta;
      if (S.selected === e.nodeId) updateOutput();
      break;

    case 'node_end':
      S.status[e.nodeId] = e.status;
      render();
      if (S.selected === e.nodeId) updateOutput();
      log(e.status === 'ok' ? 'ok' : 'fail',
        `   ${e.status === 'ok' ? '完成' : '失败'} ${e.ms}ms · ${e.chars} 字符`);
      break;

    case 'workflow_end':
      log(e.status === 'ok' ? 'ok' : 'fail', `■ 结束（${e.status}）${(e.ms / 1000).toFixed(1)}s`);
      void loadOutputs();
      setRunning(false);
      S.es?.close();
      S.es = null;
      break;
  }
}

/** 运行结束后拉取所有节点的完整产出。 */
async function loadOutputs() {
  if (!S.session) return;
  try {
    const outputs = await fetch(`/api/output?session=${encodeURIComponent(S.session)}`).then((r) => r.json());
    if (outputs && typeof outputs === 'object') {
      S.outputs = outputs;
      updateOutput();
      log('dim', `可点击任意节点查看其完整产出（已写入 runs/web-${S.session.slice(0, 8)}/outputs.md）`);
    }
  } catch {
    /* 拉不到就维持流式内容 */
  }
}

function setRunning(on) {
  S.running = on;
  $('run').disabled = on;
  $('run').textContent = on ? '运行中…' : '▶ 运行';
}

/* ------------------------------------------------------------------ *
 * 日志与提示
 * ------------------------------------------------------------------ */

function log(kind, text) {
  if ($('log').dataset.empty === '1') { $('log').innerHTML = ''; delete $('log').dataset.empty; }
  const el = document.createElement('div');
  el.className = kind;
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  el.innerHTML = `<span class="t">${t}</span>${esc(text)}`;
  $('log').appendChild(el);
  $('log').scrollTop = $('log').scrollHeight;
}

function banner(msg) {
  const el = $('banner');
  el.hidden = !msg;
  el.textContent = msg;
}

function emptyLog() {
  $('log').innerHTML = EMPTY_LOG;
  $('log').dataset.empty = '1';
}

boot().then(emptyLog).catch((err) => banner(`初始化失败：${err.message}`));
