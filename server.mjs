#!/usr/bin/env node
// Claude Code Task Board — ローカル管理画面サーバー（依存パッケージなし / Node 18+）
//   node server.mjs            → http://localhost:8787
//   node server.mjs --port 9000 --dir /path/to/.claude
//   環境変数 CLAUDE_CONFIG_DIR も参照します
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const PORT = Number(arg('--port', process.env.PORT || 8787));
// localhost は環境により 127.0.0.1 / ::1 のどちらにも解決されるので、既定では両方の loopback に bind する
const HOSTS = arg('--host', '') ? [arg('--host')] : ['127.0.0.1', '::1'];
const CLAUDE_DIR = path.resolve(arg('--dir', process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')));
const NOTES_FILE = path.join(__dirname, 'board-notes.json');
const ACTIVE_MIN = Number(arg('--active-minutes', 10)); // この分数以内に更新があれば「稼働中」
const DONE_DAYS = Number(arg('--done-days', 7)); // 完了タスクはこの日数以内のものだけ表示（0 で無制限）。ファイル自体は Claude Code の cleanupPeriodDays（既定30日）で消える
const USAGE_FILE = path.join(__dirname, 'usage-latest.json');  // 使用量（レート制限の %）。statusLine の stdin をそのまま、または POST /api/usage で書かれる
const USAGE_HIST = path.join(__dirname, 'usage-history.json'); // 使用量 % の履歴（14 日分）
const TOKEN_DAYS = 7; // transcript から集計するトークン消費の日数

// ---------- utils ----------
const exists = p => { try { fs.accessSync(p); return true; } catch { return false; } };
const safeJson = s => { try { return JSON.parse(s); } catch { return null; } };
async function readJson(p) { try { return safeJson(await fsp.readFile(p, 'utf8')); } catch { return null; } }
async function listDir(p) { try { return await fsp.readdir(p, { withFileTypes: true }); } catch { return []; } }
async function stat(p) { try { return await fsp.stat(p); } catch { return null; } }
async function readHead(p, bytes = 2 * 1024 * 1024) {
  const fh = await fsp.open(p, 'r'); try { const b = Buffer.alloc(bytes); const { bytesRead } = await fh.read(b, 0, bytes, 0); return b.subarray(0, bytesRead).toString('utf8'); } finally { await fh.close(); }
}
async function readTail(p, bytes = 512 * 1024) {
  const st = await stat(p); if (!st) return '';
  const start = Math.max(0, st.size - bytes);
  const fh = await fsp.open(p, 'r'); try { const b = Buffer.alloc(st.size - start); const { bytesRead } = await fh.read(b, 0, b.length, start); let s = b.subarray(0, bytesRead).toString('utf8'); if (start > 0) s = s.slice(s.indexOf('\n') + 1); return s; } finally { await fh.close(); }
}
const lines = s => s.split('\n').filter(Boolean).map(safeJson).filter(Boolean);
// ~/.claude/projects/<encoded cwd>/ のフォルダ名を人が読める形に（C--Users-foo-bar → C:/Users/foo/bar 相当）
function decodeProjectDir(name) { return name.replace(/^([A-Za-z])--/, '$1:/').replace(/-/g, '/'); }
// Windows/Unix どちらのパスでも末尾のフォルダ名を取る（Linux 上で Windows のパスを読む場合も考慮）
const baseName = p => String(p || '').split(/[\\/]+/).filter(Boolean).pop() || String(p || '');
// message.content（文字列 or ブロック配列）からテキスト部分だけを取り出す
function textOf(c) { if (typeof c === 'string') return c; if (Array.isArray(c)) return c.filter(x => x?.type === 'text' && x.text).map(x => x.text).join('\n'); return ''; }
// Claude Code がユーザー発話に注入する制御タグ（システム注意書き・スラッシュコマンドのエコー・通知）を除去し、人が書いた本文だけを残す
const CONTROL_TAGS = ['system-reminder', 'command-name', 'command-message', 'command-args', 'local-command-stdout', 'local-command-stderr', 'local-command-caveat', 'task-notification', 'ci-monitor-event', 'ide_opened_file', 'ide_selection'];
function cleanPrompt(s) {
  s = String(s || '');
  for (const t of CONTROL_TAGS) s = s.replace(new RegExp(`<${t}\\b[^>]*>[\\s\\S]*?<\\/${t}>`, 'g'), '');
  return s.replace(/<\/?[a-z][a-z0-9_-]*(?:\s[^>]*)?>/gi, '').replace(/\s+/g, ' ').trim();
}

// ---------- live process registry (sessions/<pid>.json) ----------
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
async function scanLive() {
  const live = new Map(); // sessionId -> {pid, status, name, ...}
  for (const f of await listDir(path.join(CLAUDE_DIR, 'sessions'))) {
    if (!f.isFile() || !/^\d+\.json$/.test(f.name)) continue; // <pid>.<hash>.key などは無視
    const j = await readJson(path.join(CLAUDE_DIR, 'sessions', f.name));
    if (!j?.sessionId || !j.pid || !alive(j.pid)) continue;
    live.set(j.sessionId, { pid: j.pid, status: j.status || 'busy', name: j.name || '', cwd: j.cwd, version: j.version, kind: j.kind, startedAt: j.startedAt, updatedAt: j.updatedAt });
  }
  return live;
}

// ---------- sessions (projects/*.jsonl) ----------
async function scanSessions() {
  const root = path.join(CLAUDE_DIR, 'projects');
  const sessions = new Map();
  const live = await scanLive();
  for (const proj of await listDir(root)) {
    if (!proj.isDirectory()) continue;
    const pdir = path.join(root, proj.name);
    for (const f of await listDir(pdir)) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      const file = path.join(pdir, f.name);
      const st = await stat(file); if (!st || st.size === 0) continue;
      const id = f.name.replace(/\.jsonl$/, '');
      // デスクトップアプリで削除されたセッションは <id>.desktop-released.json (reason:"delete") が残る → 表示しない
      const released = await readJson(path.join(pdir, `${id}.desktop-released.json`));
      if (released?.reason === 'delete' && !live.has(id)) continue;
      const head = lines(await readHead(file));
      const tail = lines(await readTail(file));
      // 小さいファイルでは head と tail が重複するので、「最新」は tail→head の順、「最古」は head→tail の順で探す
      const latest = pred => [...tail].reverse().find(pred) || [...head].reverse().find(pred);
      const earliest = pred => head.find(pred) || tail.find(pred);
      const lv = live.get(id);
      // cwd: 直近の relocated 行 / cwd 付き行 → 稼働中プロセスの値 → フォルダ名から復元
      //（sessions/<pid>.json の cwd は起動時の値のままで、途中でフォルダを移動しても更新されない。transcript の行が最新）
      const cwdLine = latest(l => l.relocatedCwd || l.cwd);
      const cwd = cwdLine?.relocatedCwd || cwdLine?.cwd || lv?.cwd || decodeProjectDir(proj.name);
      // ブランチ: "HEAD" は detached または git 管理外なので空扱い
      const rawBranch = latest(l => l.gitBranch)?.gitBranch || '';
      const branch = rawBranch === 'HEAD' ? '' : rawBranch;
      // タイトル: 稼働プロセスの名前 → custom-title（行 or <id>/custom-title.json）→ summary → 最初の依頼文
      const customTitle = latest(l => l.type === 'custom-title' && l.customTitle)?.customTitle || (await readJson(path.join(pdir, id, 'custom-title.json')))?.customTitle || '';
      const summary = latest(l => l.type === 'summary' && l.summary)?.summary || '';
      let firstPrompt = '';
      for (const l of [...head, ...tail]) { if (l.type !== 'user' || l.isMeta || l.isSidechain) continue; const t = cleanPrompt(textOf(l.message?.content)); if (t) { firstPrompt = t; break; } }
      const isMsg = l => (l.type === 'assistant' || l.type === 'user') && !l.isMeta && l.message;
      const last = latest(isMsg) || latest(l => l.timestamp) || {};
      const lastTs = Date.parse(last.timestamp || '') || st.mtimeMs;
      const ageMin = (Date.now() - lastTs) / 60000;
      // 状態推定: 最終行がツール呼び出し/ツール結果 → エージェント稼働中、テキストで終了 → あなたの入力待ち
      let state = 'idle';
      if (lv) state = lv.status === 'idle' ? 'you' : 'agent';
      else if (ageMin <= ACTIVE_MIN) {
        const content = last.message?.content;
        const hasToolUse = Array.isArray(content) && content.some(c => c.type === 'tool_use');
        const isToolResult = last.type === 'user' && Array.isArray(content) && content.some(c => c.type === 'tool_result');
        state = (hasToolUse || isToolResult) ? 'agent' : (last.type === 'assistant' ? 'you' : 'agent');
      }
      // 最後の TodoWrite（旧方式のタスク一覧）を拾う
      let todos = null;
      for (let i = tail.length - 1; i >= 0 && !todos; i--) {
        const c = tail[i].message?.content; if (!Array.isArray(c)) continue;
        const tw = c.find(x => x.type === 'tool_use' && x.name === 'TodoWrite' && Array.isArray(x.input?.todos));
        if (tw) todos = tw.input.todos;
      }
      // 直近のアシスタント発話（thinking / tool_use は除く）
      const lastText = textOf(latest(l => l.type === 'assistant' && textOf(l.message?.content).trim())?.message?.content).trim();
      sessions.set(id, {
        id, cwd, project: baseName(cwd) || cwd, branch,
        title: (lv?.name || customTitle || summary || firstPrompt || '(無題セッション)').replace(/\s+/g, ' ').slice(0, 120),
        startedAt: Date.parse(earliest(l => l.timestamp)?.timestamp || '') || st.birthtimeMs || st.mtimeMs, lastAt: lastTs, ageMin: Math.round(ageMin),
        state, running: !!lv, pid: lv?.pid || null, name: lv?.name || '', version: lv?.version || '',
        lastText: lastText.slice(0, 300), size: st.size, todos, file, pdir,
      });
    }
  }
  return sessions;
}

// ---------- tasks (tasks/<session>/*.json  +  todos/*.json) ----------
// サブエージェントの表示名: projects/<enc>/<session>/subagents/agent-<id>.jsonl があれば agent-name 行か最初の依頼文を使う
async function agentLabel(session, agentId) {
  const short = agentId.slice(0, 8);
  if (!session?.pdir) return `サブエージェント ${short}`;
  const sdir = path.join(session.pdir, session.id, 'subagents');
  const f = (await listDir(sdir)).find(e => e.isFile() && e.name.startsWith(`agent-${agentId}`) && e.name.endsWith('.jsonl'));
  if (!f) return `サブエージェント ${short}`;
  const head = lines(await readHead(path.join(sdir, f.name), 256 * 1024));
  const named = head.find(l => l.type === 'agent-name' && l.agentName)?.agentName;
  if (named) return `サブエージェント ${named}`;
  for (const l of head) { if (l.type !== 'user' || l.isMeta) continue; const t = cleanPrompt(textOf(l.message?.content)); if (t) return `サブエージェント: ${t.slice(0, 40)}${t.length > 40 ? '…' : ''}`; }
  return `サブエージェント ${short}`;
}
async function scanTasks(sessions) {
  const tasks = [];
  const troot = path.join(CLAUDE_DIR, 'tasks');
  for (const d of await listDir(troot)) {
    if (!d.isDirectory()) continue;
    const dir = path.join(troot, d.name);
    for (const f of await listDir(dir)) {
      if (!f.isFile() || !f.name.endsWith('.json')) continue;
      const file = path.join(dir, f.name);
      const j = await readJson(file); const st = await stat(file);
      if (!j || typeof j !== 'object') continue;
      const rows = Array.isArray(j) ? j : [j];
      for (const t of rows) {
        if (!t || !(t.subject || t.content || t.title)) continue;
        tasks.push({
          id: `${d.name}:${t.id ?? f.name.replace(/\.json$/, '')}`, source: 'tasks', sessionId: d.name,
          subject: t.subject || t.content || t.title, description: t.description || '', activeForm: t.activeForm || '',
          status: normStatus(t.status), owner: t.owner || '', blocks: t.blocks || [], blockedBy: t.blockedBy || [],
          metadata: t.metadata || {}, updatedAt: Date.parse(t.updatedAt || '') || st?.mtimeMs || Date.now(), createdAt: Date.parse(t.createdAt || '') || st?.birthtimeMs || null,
        });
      }
    }
  }
  // 旧 TodoWrite 形式: todos/<session>-agent-<agent>.json
  const droot = path.join(CLAUDE_DIR, 'todos');
  const labelCache = new Map();
  for (const f of await listDir(droot)) {
    if (!f.isFile() || !f.name.endsWith('.json')) continue;
    const file = path.join(droot, f.name);
    const j = await readJson(file); const st = await stat(file);
    if (!Array.isArray(j) || !j.length) continue;
    const m = f.name.match(/^([0-9a-f-]{36})(?:-agent-([0-9a-f-]+))?/i);
    const sid = m ? m[1] : f.name; const agent = m?.[2] && m[2] !== m[1] ? m[2] : '';
    let owner = '';
    if (agent) { const k = `${sid}:${agent}`; if (!labelCache.has(k)) labelCache.set(k, await agentLabel(sessions.get(sid), agent)); owner = labelCache.get(k); }
    j.forEach((t, i) => tasks.push({
      id: `todo:${f.name}:${t.id ?? i}`, source: 'todos', sessionId: sid,
      subject: t.content || t.subject || '', description: '', activeForm: t.activeForm || '', status: normStatus(t.status), owner,
      blocks: [], blockedBy: [], metadata: agent ? { agentId: agent } : {}, updatedAt: st?.mtimeMs || Date.now(), createdAt: null,
    }));
  }
  // どちらにも無いセッションは transcript 内の最後の TodoWrite をフォールバックに
  const haveTaskSessions = new Set(tasks.map(t => t.sessionId));
  for (const s of sessions.values()) {
    if (haveTaskSessions.has(s.id) || !s.todos) continue;
    s.todos.forEach((t, i) => tasks.push({
      id: `tw:${s.id}:${i}`, source: 'transcript', sessionId: s.id, subject: t.content || '', description: '', activeForm: t.activeForm || '',
      status: normStatus(t.status), owner: '', blocks: [], blockedBy: [], metadata: {}, updatedAt: s.lastAt, createdAt: null,
    }));
  }
  return tasks.filter(t => t.subject);
}
function normStatus(s) { s = String(s || 'pending').toLowerCase(); if (/progress|active|doing/.test(s)) return 'in_progress'; if (/complete|done|resolved|closed/.test(s)) return 'completed'; if (/delete|cancel/.test(s)) return 'deleted'; return 'pending'; }

// ---------- usage: レート制限の %（usage-latest.json） ----------
// 受け付ける形式は 2 つ:
//   1. Claude Code の statusLine に渡される stdin JSON（rate_limits.five_hour / seven_day / …）。settings.json の statusLine で
//      `cat > <このフォルダ>/usage-latest.json` とすれば自動で更新される（ターミナルの claude のみ。デスクトップアプリは statusLine を実行しない）
//   2. POST /api/usage の {windows:[{label, percentUsed, resetsAt}]}（デスクトップの get_usage の出力そのまま、または {plan:{windows}} で包んだもの）
const WINDOW_LABELS = { five_hour: '5時間制限', seven_day: '週間・全モデル', spend_limit: '追加利用（支出上限）' };
function windowKey(label) {
  const l = String(label || '').toLowerCase();
  if (/5.?hour|5 ?時間/.test(l)) return 'five_hour';
  // "Weekly · all models" → seven_day, "Weekly · Fable" → seven_day_fable。区切り文字（·）は Windows の curl 引数経由で cp932 の「・」(81 45) に化け、
  // UTF-8 で読むと U+FFFD + "E" になるので、U+FFFD とその直後の 1 文字を捨ててから英数字だけで判定する
  if (/week|週/.test(l)) { const rest = l.replace(/�./g, '').replace(/weekly|week|週間|週|all models|全モデル|limit/g, '').replace(/[^a-z0-9]+/g, ' ').trim(); return rest ? 'seven_day_' + rest.replace(/\s+/g, '_') : 'seven_day'; }
  return l.replace(/\W+/g, '_') || 'unknown';
}
function windowLabel(key, raw) { if (WINDOW_LABELS[key]) return WINDOW_LABELS[key]; const m = key.match(/^seven_day_(.+)$/); return m ? '週間・' + m[1].replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase()) : (raw || key); }
const toMs = v => v == null ? null : typeof v === 'number' ? (v < 1e11 ? v * 1000 : v) : (Date.parse(v) || null);
function normalizeUsage(j) {
  if (!j || typeof j !== 'object') return null;
  if (j.plan?.windows && !j.windows) j = { ...j, windows: j.plan.windows, planName: j.plan.plan };
  const windows = [];
  if (j.rate_limits && typeof j.rate_limits === 'object') {
    for (const [k, v] of Object.entries(j.rate_limits)) if (v && v.used_percentage != null) windows.push({ key: k, label: windowLabel(k), pct: Number(v.used_percentage), resetsAt: toMs(v.resets_at) });
  } else if (Array.isArray(j.windows)) {
    for (const w of j.windows) { const pct = Number(w.pct ?? w.percentUsed ?? w.used_percentage); if (Number.isNaN(pct)) continue; const key = w.key || windowKey(w.label); windows.push({ key, label: windowLabel(key, w.label), pct, resetsAt: toMs(w.resetsAt ?? w.resets_at) }); }
  }
  if (!windows.length) return null;
  return { source: j.source || (j.rate_limits ? 'statusline' : 'push'), at: Number(j.at) || null, plan: j.planName || j.plan?.plan || (typeof j.plan === 'string' ? j.plan : ''), windows };
}
async function readUsage() {
  const st = await stat(USAGE_FILE); if (!st) return null;
  const u = normalizeUsage(await readJson(USAGE_FILE)); if (!u) return null;
  u.at = u.at || st.mtimeMs; return u;
}
let histCache = null;
async function recordUsage(u) {
  if (!histCache) histCache = (await readJson(USAGE_HIST)) || [];
  if (u) {
    const last = histCache[histCache.length - 1];
    const w = Object.fromEntries(u.windows.map(x => [x.key, x.pct]));
    const changed = !last || JSON.stringify(last.w) !== JSON.stringify(w);
    if (!last || (u.at > last.at && (changed || u.at - last.at >= 30 * 60e3))) {
      histCache.push({ at: u.at, w });
      const cutoff = Date.now() - 14 * 864e5; histCache = histCache.filter(h => h.at >= cutoff);
      fsp.writeFile(USAGE_HIST, JSON.stringify(histCache)).catch(() => {});
    }
  }
  return histCache;
}

// ---------- tokens: transcript の message.usage を集計 ----------
// 各 transcript は追記のみなので、前回読んだ位置から差分だけ読む
const tokenCache = new Map(); // file -> {pos, size, events, hits}
async function readFrom(p, start) { // start 以降を「完全な行」の単位で読む
  const st = await stat(p); if (!st || st.size <= start) return { text: '', end: start, size: st?.size ?? 0 };
  const fh = await fsp.open(p, 'r');
  try { const b = Buffer.alloc(st.size - start); const { bytesRead } = await fh.read(b, 0, b.length, start); const buf = b.subarray(0, bytesRead); const nl = buf.lastIndexOf(10); if (nl < 0) return { text: '', end: start, size: st.size }; return { text: buf.subarray(0, nl + 1).toString('utf8'), end: start + nl + 1, size: st.size }; } finally { await fh.close(); }
}
async function scanTokens(sessions) {
  const since = Date.now() - (TOKEN_DAYS + 1) * 864e5;
  const events = [], hits = [];
  for (const s of sessions.values()) {
    const st = await stat(s.file); if (!st) continue;
    let c = tokenCache.get(s.file);
    if (!c || st.size < c.pos) c = { pos: 0, size: 0, events: [], hits: [], seen: new Set() }; // 縮んでいたら書き直されたので全読み
    if (st.size > c.pos) {
      const { text, end } = await readFrom(s.file, c.pos);
      for (const l of lines(text)) {
        if (l.type !== 'assistant' || !l.timestamp) continue;
        const t = Date.parse(l.timestamp); if (!t) continue;
        if (l.quotaLimits?.status === 'rejected') c.hits.push({ t, type: l.quotaLimits.rateLimitType || '', resetsAt: toMs(l.quotaLimits.resetsAt) });
        const u = l.message?.usage, model = l.message?.model || '';
        if (!u || model === '<synthetic>') continue;
        const id = l.message.id || l.uuid; if (c.seen.has(id)) continue; c.seen.add(id); // 1 メッセージが content ブロックごとに複数行に分かれ usage が重複する
        c.events.push({ t, model, fresh: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0), cached: u.cache_read_input_tokens || 0, out: u.output_tokens || 0 });
      }
      c.pos = end; c.size = st.size;
      c.events = c.events.filter(e => e.t >= since); c.hits = c.hits.filter(h => h.t >= since);
      if (c.seen.size > 5000) c.seen = new Set([...c.seen].slice(-2000));
      tokenCache.set(s.file, c);
    }
    events.push(...c.events.filter(e => e.t >= since)); hits.push(...c.hits);
  }
  return bucketTokens(events, hits);
}
function bucketTokens(events, hits) {
  const now = Date.now(), isFable = m => /fable/i.test(m);
  const h5start = now - 5 * 3600e3, h5 = Array.from({ length: 20 }, (_, i) => ({ t: h5start + i * 15 * 60e3, fable: 0, other: 0, cached: 0 }));
  const d7 = []; for (let i = TOKEN_DAYS - 1; i >= 0; i--) { const d = new Date(now - i * 864e5); d.setHours(0, 0, 0, 0); d7.push({ t: d.getTime(), fable: 0, other: 0, cached: 0 }); }
  const dayIdx = t => { for (let i = d7.length - 1; i >= 0; i--) if (t >= d7[i].t) return i; return -1; };
  for (const e of events) {
    const k = isFable(e.model) ? 'fable' : 'other';
    if (e.t >= h5start) { const b = h5[Math.min(19, Math.floor((e.t - h5start) / (15 * 60e3)))]; b[k] += e.fresh; b.cached += e.cached; }
    const di = dayIdx(e.t); if (di >= 0) { d7[di][k] += e.fresh; d7[di].cached += e.cached; }
  }
  const models = {}; for (const e of events) models[e.model] = (models[e.model] || 0) + e.fresh;
  return { h5, d7, hits: hits.filter(h => h.t >= d7[0].t).sort((a, b) => a.t - b.t), models };
}

// ---------- state ----------
let cache = { at: 0, data: null };
async function buildState() {
  if (Date.now() - cache.at < 2000 && cache.data) return cache.data;
  const sessions = await scanSessions();
  const all = (await scanTasks(sessions)).filter(t => t.status !== 'deleted');
  const byId = new Map(all.map(t => [t.id, t]));
  // 古い完了タスクは省く（updatedAt はファイル更新時刻 ≒ 完了時刻）
  const tasks = all.filter(t => t.status !== 'completed' || DONE_DAYS <= 0 || Date.now() - t.updatedAt < DONE_DAYS * 864e5);
  for (const t of tasks) {
    const openBlockers = (t.blockedBy || []).map(b => byId.get(`${t.sessionId}:${b}`)).filter(x => x && x.status !== 'completed');
    t.blocked = t.status !== 'completed' && openBlockers.length > 0;
    t.blockerSubjects = openBlockers.map(x => x.subject);
    const s = sessions.get(t.sessionId);
    t.session = s ? { id: s.id, project: s.project, cwd: s.cwd, branch: s.branch, state: s.state, title: s.title, lastAt: s.lastAt } : { id: t.sessionId, project: '(不明)', cwd: '', branch: '', state: 'idle', title: '', lastAt: t.updatedAt };
  }
  // タスクのある or 直近のセッションだけ返す（古いものは省く）
  const sessArr = [...sessions.values()].filter(s => s.state !== 'idle' || tasks.some(t => t.sessionId === s.id) || (Date.now() - s.lastAt) < 7 * 864e5)
    .sort((a, b) => (b.running - a.running) || (b.lastAt - a.lastAt)).slice(0, 60).map(({ todos, file, pdir, ...rest }) => ({ ...rest, taskCount: tasks.filter(t => t.sessionId === rest.id).length }));
  const notes = (await readJson(NOTES_FILE)) || {};
  const latest = await readUsage();
  const usage = { ...(latest || { source: '', at: null, plan: '', windows: null }), history: await recordUsage(latest), tokens: await scanTokens(sessions) };
  const data = { scannedAt: Date.now(), claudeDir: CLAUDE_DIR, dirExists: exists(CLAUDE_DIR), activeMinutes: ACTIVE_MIN, doneDays: DONE_DAYS, sessions: sessArr, tasks, notes, usage };
  cache = { at: Date.now(), data };
  return data;
}

// ---------- server ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/state') { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); return res.end(JSON.stringify(await buildState())); }
    if (url.pathname === '/api/notes' && req.method === 'POST') {
      let body = ''; for await (const c of req) body += c; const j = safeJson(body);
      if (!j || typeof j !== 'object') { res.writeHead(400); return res.end('bad json'); }
      await fsp.writeFile(NOTES_FILE, JSON.stringify(j, null, 2)); cache.at = 0;
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true}');
    }
    if (url.pathname === '/api/usage' && req.method === 'POST') { // 使用量 % を外から押し込む（デスクトップの get_usage の出力など）
      let body = ''; for await (const c of req) body += c; const u = normalizeUsage(safeJson(body));
      if (!u) { res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('windows が見つかりません: {windows:[{label, percentUsed, resetsAt}]} か statusLine の JSON を送ってください'); }
      u.source = 'push'; u.at = Date.now();
      await fsp.writeFile(USAGE_FILE, JSON.stringify(u, null, 2)); cache.at = 0;
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ ok: true, windows: u.windows }));
    }
    if (url.pathname === '/api/events') { // SSE: ファイル更新を軽く通知
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write('retry: 3000\n\n');
      const t = setInterval(() => res.write(`data: ${Date.now()}\n\n`), 5000);
      req.on('close', () => clearInterval(t)); return;
    }
    const file = path.join(__dirname, url.pathname === '/' ? 'index.html' : url.pathname.replace(/\.\./g, ''));
    if (file.startsWith(__dirname) && exists(file) && fs.statSync(file).isFile()) { res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' }); return fs.createReadStream(file).pipe(res); }
    res.writeHead(404); res.end('not found');
  } catch (e) { res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }); res.end(String(e?.stack || e)); }
}
// 各 loopback アドレスに個別に bind する（片方だけ他アプリに使われていても、空いている側では動く）
function listen(host) {
  return new Promise(resolve => {
    const s = http.createServer(handle);
    s.once('error', err => resolve({ host, err }));
    s.listen(PORT, host, () => resolve({ host, server: s }));
  });
}
const bound = await Promise.all(HOSTS.map(listen));
const ok = bound.filter(b => b.server), ng = bound.filter(b => b.err);
if (!ok.length) {
  console.error(`\n  ポート ${PORT} を開けません（${ng.map(b => `${b.host}: ${b.err.code}`).join(', ')}）。--port で別のポートを指定してください。\n`);
  process.exit(1);
}
console.log(`\n  Claude Code Task Board\n  → http://localhost:${PORT}${ok.some(b => b.host === '127.0.0.1') ? `  (http://127.0.0.1:${PORT})` : ''}\n  読み取り元: ${CLAUDE_DIR} ${exists(CLAUDE_DIR) ? '' : '（見つかりません: --dir で指定してください）'}`);
for (const b of ng) if (b.err.code === 'EADDRINUSE') console.log(`  注意: ${b.host}:${PORT} は別のプロセスが使用中です。localhost がそちらに解決される場合は別アプリの画面が出るので、--port で別ポートを指定してください。`);
console.log('');
