/**
 * OpenCode Virtual Office HQ — local bridge (v2, live-first)
 *
 * Discovers the running local OpenCode service, subscribes to its event
 * stream, and exposes:
 *   - a live session snapshot (title, directory, model, status, tokens, cost,
 *     activity) over WebSocket
 *   - real events mapped to the dashboard wire format
 *   - request/response for real session diffs
 *
 * Usage:
 *   npm run bridge                     # auto-discover, ws://127.0.0.1:4040
 *   npm run bridge -- --port 4041
 *   npm run bridge -- --directory "D:\\path\\to\\project"
 *   npm run bridge -- --url http://127.0.0.1:28894
 *
 * Read-only: the bridge never creates sessions or sends prompts.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { OpenCode } from '@opencode/client';
import { Service } from '@opencode/client/service';
import { clean, errorText } from './sanitize';
import { FileSources, type FileSessionEvent } from './file-sources';

/* ------------------------------------------------------------------ config */
interface Args {
  host: string;
  port: number;
  url?: string;
  directory?: string;
  noCodex: boolean;
  noClaude: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { host: '127.0.0.1', port: 4040, noCodex: false, noClaude: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === '--port' && next) {
      const n = Number(next);
      if (Number.isInteger(n) && n > 0 && n < 65536) args.port = n;
      i++;
    } else if (flag === '--host' && next) {
      args.host = next;
      i++;
    } else if (flag === '--url' && next) {
      args.url = next;
      i++;
    } else if (flag === '--directory' && next) {
      args.directory = next;
      i++;
    } else if (flag === '--no-codex') {
      args.noCodex = true;
    } else if (flag === '--no-claude') {
      args.noClaude = true;
    } else if (flag === '--help' || flag === '-h') {
      console.log(
        'OpenCode mansion bridge\n  --port <n>        WebSocket port (default 4040)\n  --host <addr>     Bind address (default 127.0.0.1)\n  --url <url>       Explicit OpenCode service URL (skip discovery)\n  --directory <dir> Only forward events from this project directory\n  --no-codex        Do not tail Codex CLI sessions (~/.codex)\n  --no-claude       Do not tail Claude Code sessions (~/.claude)',
      );
      process.exit(0);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

/* --------------------------------------------------------------- wire types */
type AgentKey =
  | 'ada'
  | 'leo'
  | 'mia'
  | 'dylan'
  | 'nova'
  | 'quinn'
  | 'kai'
  | 'iris'
  | 'otto'
  | 'max'
  | 'system';
type WireType = 'THOUGHT' | 'TOOL' | 'BASH' | 'SUCCESS' | 'INFO' | 'USER' | 'ASSISTANT';
type SessionStatus = 'running' | 'idle' | 'failed';

interface WireEvent {
  kind: 'event';
  agent: AgentKey;
  type: WireType;
  tool?: string;
  message: string;
  session?: string;
  sessionTitle?: string;
}

interface SessionActivity {
  type: WireType;
  text: string;
  at: number;
}

interface SessionSummary {
  id: string;
  /** Where the session comes from: the OpenCode service or a local transcript. */
  source: 'opencode' | 'codex' | 'claude';
  title: string;
  directory: string;
  persona: AgentKey;
  agent?: string;
  model?: { providerID: string; modelID: string; label: string };
  status: SessionStatus;
  outcome?: string;
  tokens: number;
  cost: number;
  created: number;
  updated: number;
  idle?: number;
  activity?: SessionActivity;
}

interface SessionsSnapshot {
  kind: 'sessions';
  sessions: SessionSummary[];
  totals: { tokens: number; cost: number };
  running: number;
  ts: number;
}

interface RawEvent {
  type: string;
  data?: Record<string, unknown>;
  location?: { directory?: string };
}

interface HistoryMessage {
  id: string;
  role: 'user' | 'assistant';
  at: number;
  text?: string;
  reasoning?: string;
  tools?: { name: string; status?: string; summary?: string }[];
}

/* ------------------------------------------------------------------ helpers */
const AGENT_POOL: AgentKey[] = ['ada', 'leo', 'mia', 'dylan', 'nova', 'quinn', 'kai', 'iris', 'otto', 'max'];
const SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 30;

const sessionMeta = new Map<string, { persona: AgentKey; activity?: SessionActivity; title?: string }>();
const toolNames = new Map<string, string>();
const lastProgress = new Map<string, number>();
let latestSessions: SessionSummary[] = [];
let latestTotals = { tokens: 0, cost: 0 };
let latestRunning = 0;
let client: ReturnType<typeof OpenCode.make> | null = null;
let serviceInfo: { url: string; version?: string } | null = null;

/** Codex CLI + Claude Code transcripts, tailed locally (read-only). */
const fileSources = new FileSources({ codex: !args.noCodex, claude: !args.noClaude });

function sourcesInfo(): Record<string, unknown> {
  const roots = fileSources.roots();
  return {
    opencode: client ? (serviceInfo?.url ?? true) : false,
    codex: roots.codex,
    claude: roots.claude,
  };
}

function isFileSession(id: string): boolean {
  return id.startsWith('codex:') || id.startsWith('claude:');
}

// Broadcast freshly tailed Codex/Claude records through the same pipeline.
fileSources.on('event', (event: FileSessionEvent) => {
  emit(event.sessionID, event.type, event.message, event.tool);
});

function fnv(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return Math.abs(h);
}

function sessionMetaFor(id: string): { persona: AgentKey; activity?: SessionActivity; title?: string } {
  let meta = sessionMeta.get(id);
  if (!meta) {
    meta = { persona: AGENT_POOL[fnv(id) % AGENT_POOL.length] ?? 'dylan' };
    sessionMeta.set(id, meta);
  }
  return meta;
}

const ANSI = /\u001b\[[0-9;]*m/g;

function shortTitle(value: string): string {
  return clean(value, 64).replace(ANSI, '').replace(/\s+/g, ' ');
}

function titleFor(item: { title?: string; subpath?: string; location?: { directory?: string } }): string {
  const title = item.title?.trim();
  if (title) return shortTitle(title);
  const sub = item.subpath?.trim();
  if (sub) return shortTitle(sub);
  const dir = item.location?.directory ?? '';
  const base = dir.split(/[\\/]/).filter(Boolean).pop();
  return base ? shortTitle(base) : 'Untitled session';
}

function tokenTotal(tokens: unknown): number {
  if (!tokens || typeof tokens !== 'object') return 0;
  const t = tokens as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const cache = (t['cache'] ?? {}) as Record<string, unknown>;
  return num(t['input']) + num(t['output']) + num(t['reasoning']) + num(cache['read']) + num(cache['write']);
}

function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1_000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  return `${(n / 1_000_000_000).toFixed(2)}B`;
}

function summarizeInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const i = input as Record<string, unknown>;
  const keys = ['command', 'cmd', 'filePath', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt'];
  for (const key of keys) {
    if (typeof i[key] === 'string' && i[key]) return clean(i[key], 140);
  }
  return '';
}

function toolResultText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    const text = entry['text'];
    if (typeof text === 'string' && text.trim()) return clean(text, 160);
  }
  return '';
}

function modelLabel(model: unknown): string {
  if (!model || typeof model !== 'object') return '';
  const m = model as Record<string, unknown>;
  const provider = typeof m['providerID'] === 'string' ? m['providerID'] : '';
  const id = typeof m['id'] === 'string' ? m['id'] : '';
  return provider && id ? `${provider}/${id}` : clean(model, 80);
}

/* ------------------------------------------------------------------ logging */
function log(agent: AgentKey, type: WireType, message: string): void {
  const stamp = new Date().toLocaleTimeString('en-GB', { hour12: false });
  console.log(`[${stamp}] ${agent.padEnd(6)} ${type.padEnd(9)} ${clean(message, 160)}`);
}

/* ------------------------------------------------------------ ws broadcasting */
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(
      JSON.stringify({
        ok: true,
        bridge: '3.0.0',
        service: serviceInfo,
        sources: sourcesInfo(),
        clients: wss.clients.size,
        sessions: latestSessions.length,
        running: latestRunning,
        totals: latestTotals,
        uptimeSeconds: Math.round(process.uptime()),
      }),
    );
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

const wss = new WebSocketServer({ server });

function send(ws: WebSocket, payload: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  if (ws.bufferedAmount > 4_000_000) return;
  ws.send(JSON.stringify(payload));
}

function broadcast(payload: unknown): void {
  const encoded = JSON.stringify(payload);
  for (const ws of wss.clients) {
    if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 4_000_000) ws.send(encoded);
  }
}

function sessionsPayload(): SessionsSnapshot {
  return {
    kind: 'sessions',
    sessions: latestSessions,
    totals: latestTotals,
    running: latestRunning,
    ts: Date.now(),
  };
}

wss.on('connection', (ws) => {
  const alive = { value: true };
  ws.on('pong', () => {
    alive.value = true;
  });
  setInterval(() => {
    if (!alive.value) {
      ws.terminate();
      return;
    }
    alive.value = false;
    ws.ping();
  }, 30_000).unref();

  send(ws, {
    kind: 'hello',
    bridge: '3.0.0',
    service: serviceInfo,
    sources: sourcesInfo(),
    now: Date.now(),
  });
  send(ws, sessionsPayload());

  ws.on('message', (raw) => {
    void handleRequest(ws, raw.toString());
  });
  ws.on('error', () => ws.terminate());
});

async function handleRequest(ws: WebSocket, raw: string): Promise<void> {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return;
  }
  if (msg['kind'] !== 'request' || typeof msg['id'] !== 'string') return;
  const requestId = msg['id'] as string;

  if (msg['op'] === 'diff' && typeof msg['sessionID'] === 'string') {
    if (isFileSession(msg['sessionID'])) {
      // File-based sources have no live diff; the UI falls back gracefully.
      send(ws, { kind: 'response', id: requestId, ok: true, data: [] });
      return;
    }
    if (client) {
      try {
        const data = await client.session.diff({ sessionID: msg['sessionID'] as string });
        send(ws, { kind: 'response', id: requestId, ok: true, data });
      } catch (err) {
        send(ws, { kind: 'response', id: requestId, ok: false, error: errorText(err) });
      }
      return;
    }
  }

  if (msg['op'] === 'history' && typeof msg['sessionID'] === 'string') {
    if (isFileSession(msg['sessionID'])) {
      send(ws, { kind: 'response', id: requestId, ok: true, data: { messages: [], files: [] } });
      return;
    }
    if (client) {
      try {
        const data = await historyFor(msg['sessionID'] as string);
        send(ws, { kind: 'response', id: requestId, ok: true, data });
      } catch (err) {
        send(ws, { kind: 'response', id: requestId, ok: false, error: errorText(err) });
      }
      return;
    }
  }

  send(ws, { kind: 'response', id: requestId, ok: false, error: 'unsupported request' });
}

/* ------------------------------------------------------------- event mapping */
function emit(sessionID: string | undefined, type: WireType, message: string, tool?: string): void {
  const text = clean(message, 1200);
  if (!text) return;
  const meta = sessionID ? sessionMetaFor(sessionID) : null;
  const agent = meta?.persona ?? 'system';
  const title = sessionID ? (latestSessions.find((s) => s.id === sessionID)?.title ?? meta?.title) : undefined;
  if (sessionID) {
    meta!.activity = { type, text, at: Date.now() };
  }
  const event: WireEvent = { kind: 'event', agent, type, message: text };
  if (tool) event.tool = clean(tool, 48);
  if (sessionID) event.session = sessionID;
  if (title) event.sessionTitle = shortTitle(title);
  log(agent, type, text);
  broadcast(event);
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleRefresh(delay = 600): void {
  if (refreshTimer !== null) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void refreshSessions();
  }, delay);
}

function handle(raw: RawEvent): void {
  const data = (raw.data ?? {}) as Record<string, unknown>;
  const sessionID = typeof data['sessionID'] === 'string' ? (data['sessionID'] as string) : undefined;
  const key = (name: string): string => `${sessionID ?? 'global'}:${name}`;

  if (args.directory && raw.location?.directory) {
    const a = raw.location.directory.replace(/\\/g, '/').toLowerCase();
    const b = args.directory.replace(/\\/g, '/').toLowerCase();
    if (!a.startsWith(b)) return;
  }

  switch (raw.type) {
    case 'server.connected':
      emit(undefined, 'INFO', 'OpenCode service event stream connected');
      scheduleRefresh(200);
      break;

    case 'session.created': {
      if (sessionID) {
        const meta = sessionMetaFor(sessionID);
        const title = typeof data['title'] === 'string' ? (data['title'] as string) : undefined;
        if (title) meta.title = shortTitle(title);
        emit(sessionID, 'INFO', `Session started${title ? `: ${title}` : ''}`);
        scheduleRefresh(200);
      }
      break;
    }

    case 'session.renamed': {
      if (sessionID) {
        const title = typeof data['title'] === 'string' ? (data['title'] as string) : 'untitled';
        sessionMetaFor(sessionID).title = shortTitle(title);
        emit(sessionID, 'INFO', `Session renamed: ${title}`);
        scheduleRefresh(200);
      }
      break;
    }

    case 'session.deleted':
      if (sessionID) {
        emit(sessionID, 'INFO', 'Session deleted');
        sessionMeta.delete(sessionID);
        scheduleRefresh(200);
      }
      break;

    case 'session.execution.started':
      emit(sessionID, 'INFO', 'Execution started');
      scheduleRefresh(400);
      break;
    case 'session.execution.succeeded':
      emit(sessionID, 'SUCCESS', 'Execution completed');
      scheduleRefresh(300);
      break;
    case 'session.execution.failed':
      emit(sessionID, 'INFO', `Execution failed: ${errorText(data['error'])}`);
      scheduleRefresh(300);
      break;
    case 'session.execution.interrupted':
      emit(sessionID, 'INFO', 'Execution interrupted');
      scheduleRefresh(300);
      break;

    case 'session.reasoning.ended': {
      const text = typeof data['text'] === 'string' ? data['text'] : '';
      if (text.trim()) emit(sessionID, 'THOUGHT', text);
      break;
    }

    case 'session.text.ended': {
      const text = typeof data['text'] === 'string' ? data['text'] : '';
      if (text.trim()) emit(sessionID, 'ASSISTANT', text);
      break;
    }

    case 'session.tool.input.started': {
      const toolID = typeof data['id'] === 'string' ? data['id'] : '';
      const name = typeof data['name'] === 'string' ? data['name'] : '';
      if (toolID && name) toolNames.set(key(toolID), name);
      break;
    }

    case 'session.tool.called': {
      const toolID = typeof data['id'] === 'string' ? data['id'] : '';
      const name = toolNames.get(key(toolID)) ?? 'tool';
      const summary = summarizeInput(data['input']);
      emit(sessionID, 'TOOL', `${name}${summary ? ` · ${summary}` : ''}`, name);
      break;
    }

    case 'session.tool.progress': {
      const toolID = typeof data['id'] === 'string' ? data['id'] : '';
      const name = toolNames.get(key(toolID)) ?? 'tool';
      const throttleKey = `progress:${key(toolID)}`;
      const now = Date.now();
      const last = lastProgress.get(throttleKey) ?? 0;
      if (now - last < 900) break;
      lastProgress.set(throttleKey, now);
      const meta = data['metadata'];
      const label =
        meta && typeof meta === 'object'
          ? clean(
              (meta as Record<string, unknown>)['title'] ??
                (meta as Record<string, unknown>)['summary'] ??
                meta,
              140,
            )
          : '';
      emit(sessionID, 'TOOL', `${name} · ${label || 'running…'}`, name);
      break;
    }

    case 'session.tool.success': {
      const toolID = typeof data['id'] === 'string' ? data['id'] : '';
      const name = toolNames.get(key(toolID)) ?? 'tool';
      const result = toolResultText(data['content']);
      emit(sessionID, 'SUCCESS', `${name} completed${result ? ` — ${result}` : ''}`);
      break;
    }

    case 'session.tool.failed': {
      const toolID = typeof data['id'] === 'string' ? data['id'] : '';
      const name = toolNames.get(key(toolID)) ?? 'tool';
      emit(sessionID, 'INFO', `${name} failed: ${errorText(data['error'])}`);
      break;
    }

    case 'session.shell.started': {
      const shell = (data['shell'] ?? {}) as Record<string, unknown>;
      emit(sessionID, 'BASH', `$ ${clean(shell['command'], 200)}`);
      break;
    }

    case 'session.shell.ended': {
      const output = data['output'];
      const text =
        typeof output === 'string'
          ? output
          : output && typeof output === 'object'
            ? clean(
                (output as Record<string, unknown>)['output'] ??
                  (output as Record<string, unknown>)['text'] ??
                  (output as Record<string, unknown>)['stdout'] ??
                  output,
                300,
              )
            : '';
      emit(sessionID, 'BASH', text ? `shell finished: ${text}` : 'shell finished');
      break;
    }

    case 'session.usage.updated':
    case 'session.usage.recorded':
      scheduleRefresh(300);
      break;

    case 'session.retry.scheduled':
      emit(sessionID, 'INFO', `Retry scheduled (attempt ${clean(data['attempt'], 12)})`);
      break;

    case 'session.compaction.started':
      emit(sessionID, 'INFO', 'Context compaction started');
      break;
    case 'session.compaction.ended':
      emit(sessionID, 'SUCCESS', 'Context compaction finished');
      break;
    case 'session.compaction.failed':
      emit(sessionID, 'INFO', `Context compaction failed: ${errorText(data['error'])}`);
      break;

    case 'session.skill.activated': {
      const name = clean(data['skill'] ?? data['name'] ?? 'skill', 48);
      emit(sessionID, 'TOOL', `skill · ${name}`, 'skill');
      break;
    }

    case 'session.agent.selected':
      emit(sessionID, 'INFO', `Agent selected: ${clean(data['agent'], 60)}`);
      scheduleRefresh(400);
      break;

    case 'session.model.selected': {
      const label = modelLabel(data['model']);
      emit(sessionID, 'INFO', `Model selected: ${label}`);
      scheduleRefresh(400);
      break;
    }

    case 'session.step.failed':
      emit(sessionID, 'INFO', `Step failed: ${errorText(data['error'])}`);
      break;

    case 'session.revert.committed':
      emit(sessionID, 'INFO', 'Revert committed');
      scheduleRefresh(400);
      break;

    default:
      break;
  }
}

async function historyFor(sessionID: string): Promise<{ messages: HistoryMessage[]; files: string[] }> {
  if (!client) return { messages: [], files: [] };
  const context = (await client.session.context({ sessionID })) as unknown as Record<string, unknown>[];
  const messages: HistoryMessage[] = [];
  const touched = new Set<string>();

  context.slice(-80).forEach((raw) => {
    const type = raw['type'];
    if (type !== 'user' && type !== 'assistant') return;
    const content = Array.isArray(raw['content']) ? (raw['content'] as Record<string, unknown>[]) : [];
    let text = '';
    let reasoning = '';
    const tools: { name: string; status?: string; summary?: string }[] = [];
    content.forEach((part) => {
      if (!part || typeof part !== 'object') return;
      const kind = part['type'];
      if (kind === 'text' && typeof part['text'] === 'string') text += part['text'];
      else if (kind === 'reasoning' && typeof part['text'] === 'string') reasoning += part['text'];
      else if (kind === 'tool') {
        const name = typeof part['name'] === 'string' ? part['name'] : 'tool';
        const state = part['state'] && typeof part['state'] === 'object' ? (part['state'] as Record<string, unknown>) : {};
        const input = state['input'] && typeof state['input'] === 'object' ? (state['input'] as Record<string, unknown>) : {};
        const filePath = typeof input['filePath'] === 'string' ? input['filePath'] : typeof input['path'] === 'string' ? input['path'] : undefined;
        if (filePath && /^(write|edit|patch|multiedit)$/i.test(name)) touched.add(clean(filePath, 400));
        tools.push({
          name,
          status: typeof state['status'] === 'string' ? state['status'] : undefined,
          summary: summarizeInput(state['input']),
        });
      }
    });
    const at = typeof raw['time'] === 'object' ? Number((raw['time'] as Record<string, unknown>)['created'] ?? 0) : 0;
    const cleanText = clean(text, 1500);
    const cleanReasoning = clean(reasoning, 1500);
    if (!cleanText && !cleanReasoning && tools.length === 0) return;
    messages.push({
      id: typeof raw['id'] === 'string' ? raw['id'] : `msg-${at}`,
      role: type,
      at: Number.isFinite(at) ? at : 0,
      text: cleanText || undefined,
      reasoning: cleanReasoning || undefined,
      tools: tools.length ? tools.slice(-4) : undefined,
    });
  });

  return { messages: messages.slice(-30), files: [...touched].slice(-40) };
}

function activityFromHistory(messages: HistoryMessage[]): SessionActivity | undefined {
  const recent = messages.slice(-8).reverse();

  // Prefer meaningful assistant output over raw shell/tool metadata.
  for (const message of recent) {
    if (message.reasoning && message.reasoning.trim().length > 16) {
      return { type: 'THOUGHT', text: clean(message.reasoning, 300), at: message.at };
    }
  }
  for (const message of recent) {
    if (message.text && message.text.trim().length > 16) {
      return { type: 'ASSISTANT', text: clean(message.text, 300), at: message.at };
    }
  }
  for (const message of recent) {
    const tool = message.tools?.slice(-1)[0];
    if (tool?.summary) {
      return { type: 'TOOL', text: `${tool.name} · ${tool.summary}`, at: message.at };
    }
  }
  return undefined;
}

/** One-time seed so cards show real last activity before live events arrive. */
async function seedActivities(): Promise<void> {
  if (!client) return;
  try {
    const listed = await client.session.list();
    const cutoff = Date.now() - SESSION_WINDOW_MS;
    const items = listed.data
      .filter((item) => (item.time?.updated ?? 0) >= cutoff)
      .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))
      .slice(0, 12);
    await Promise.all(
      items.map(async (item) => {
        const meta = sessionMetaFor(item.id);
        if (meta.activity) return;
        try {
          const history = await historyFor(item.id);
          const activity = activityFromHistory(history.messages);
          if (activity) meta.activity = activity;
        } catch {
          /* ignore per-session errors */
        }
      }),
    );
  } catch (err) {
    console.warn(`[bridge] activity seed failed: ${errorText(err)}`);
  }
}

/* --------------------------------------------------------------- sessions */
let refreshing: Promise<void> | null = null;

async function refreshSessions(): Promise<void> {
  if (refreshing) return refreshing;
  const now = Date.now();

  refreshing = (async () => {
    const merged: SessionSummary[] = [];
    let tokens = 0;
    let cost = 0;

    try {
      /* ---------------------------------------------------- OpenCode service */
      if (client) {
        try {
          const [listed, active] = await Promise.all([
            client.session.list(),
            client.session.active().catch(() => ({}) as Record<string, unknown>),
          ]);
          const activeIds = new Set(
            Object.keys(active ?? {}).filter((id) => (active as Record<string, unknown>)[id]),
          );
          const cutoff = now - SESSION_WINDOW_MS;

          const items = listed.data
            .filter((item) => activeIds.has(item.id) || (item.time?.updated ?? 0) >= cutoff)
            .sort((a, b) => {
              const aRun = activeIds.has(a.id) ? 1 : 0;
              const bRun = activeIds.has(b.id) ? 1 : 0;
              if (aRun !== bRun) return bRun - aRun;
              return (b.time?.updated ?? 0) - (a.time?.updated ?? 0);
            });

          items.forEach((item) => {
            const meta = sessionMetaFor(item.id);
            const t = tokenTotal(item.tokens);
            const model = item.model
              ? { providerID: item.model.providerID, modelID: item.model.id, label: modelLabel(item.model) }
              : undefined;
            const status: SessionStatus = activeIds.has(item.id) ? 'running' : item.outcome === 'failed' ? 'failed' : 'idle';
            const title = titleFor(item);
            meta.title = title;
            tokens += t;
            cost += typeof item.cost === 'number' && Number.isFinite(item.cost) ? item.cost : 0;
            merged.push({
              id: item.id,
              source: 'opencode',
              title,
              directory: item.location?.directory ?? '',
              persona: meta.persona,
              agent: item.agent,
              model,
              status,
              outcome: item.outcome,
              tokens: t,
              cost: typeof item.cost === 'number' ? item.cost : 0,
              created: item.time?.created ?? 0,
              updated: item.time?.updated ?? 0,
              idle: item.time?.idle,
              activity: meta.activity,
            });
          });
        } catch (err) {
          console.warn(`[bridge] OpenCode session refresh failed: ${errorText(err)}`);
        }
      }

      /* ----------------------------------------- Codex CLI + Claude Code files */
      let fileItems = fileSources.poll();
      if (args.directory) {
        const needle = args.directory.replace(/\\/g, '/').toLowerCase();
        fileItems = fileItems.filter((f) => f.directory.replace(/\\/g, '/').toLowerCase().startsWith(needle));
      }
      for (const file of fileItems) {
        const meta = sessionMetaFor(file.id);
        const title = shortTitle(file.title);
        meta.title = title;
        const activity: SessionActivity | undefined = file.lastEventText
          ? { type: file.lastEventType ?? 'INFO', text: clean(file.lastEventText, 300), at: file.lastEventAt ?? now }
          : undefined;
        if (activity && (!meta.activity || meta.activity.at <= activity.at)) meta.activity = activity;
        tokens += file.tokens;
        merged.push({
          id: file.id,
          source: file.source,
          title,
          directory: file.directory,
          persona: meta.persona,
          agent: file.source === 'codex' ? 'codex' : 'claude',
          model: file.model,
          status: file.running ? 'running' : 'idle',
          tokens: file.tokens,
          cost: 0,
          created: file.created,
          updated: file.updated,
          activity: meta.activity,
        });
      }

      /* ------------------------------- distinct personas across the merged set */
      merged.sort((a, b) => {
        const aRun = a.status === 'running' ? 1 : 0;
        const bRun = b.status === 'running' ? 1 : 0;
        if (aRun !== bRun) return bRun - aRun;
        return b.updated - a.updated;
      });
      const used = new Set<AgentKey>();
      for (const session of merged) {
        const meta = sessionMetaFor(session.id);
        if (used.has(meta.persona)) {
          const free = AGENT_POOL.find((p) => !used.has(p));
          if (free) meta.persona = free;
        }
        used.add(meta.persona);
        session.persona = meta.persona;
      }

      latestSessions = merged.slice(0, MAX_SESSIONS);
      latestTotals = { tokens, cost: Number(cost.toFixed(4)) };
      latestRunning = latestSessions.filter((s) => s.status === 'running').length;
      broadcast(sessionsPayload());
    } finally {
      refreshing = null;
    }
  })();

  return refreshing;
}

/* -------------------------------------------------------------------- boot */
let stopping = false;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function resubscribe(c: ReturnType<typeof OpenCode.make>): Promise<void> {
  let attempts = 0;
  while (!stopping) {
    try {
      for await (const raw of c.event.subscribe()) {
        attempts = 0;
        handle(raw as unknown as RawEvent);
      }
      if (!stopping) {
        attempts += 1;
        console.warn('[bridge] event stream ended — reconnecting…');
      }
    } catch (err) {
      attempts += 1;
      if (!stopping) console.warn(`[bridge] event stream error (attempt ${attempts}): ${errorText(err)}`);
    }
    if (!stopping) await sleep(Math.min(2000 * attempts, 10_000));
  }
}

async function main(): Promise<void> {
  const roots = fileSources.roots();
  const endpoint = args.url ? { url: args.url, auth: undefined } : await Service.discover();
  if (!endpoint) {
    const sources = [roots.codex ? 'Codex CLI' : '', roots.claude ? 'Claude Code' : ''].filter(Boolean);
    if (sources.length > 0) {
      console.warn(`[bridge] No OpenCode service found — running with file sources only (${sources.join(' + ')}).`);
    } else {
      console.error(
        '[bridge] No running OpenCode service found. Start OpenCode, pass --url <url>, or run Codex / Claude Code.',
      );
      process.exit(1);
    }
  }

  if (endpoint) {
    serviceInfo = { url: endpoint.url };
    client = OpenCode.make({
      baseUrl: endpoint.url,
      headers: Service.headers(endpoint as Parameters<typeof Service.headers>[0]),
    });

    try {
      const info = await client.server.info();
      serviceInfo.version = info.version;
    } catch (err) {
      console.warn(`[bridge] could not read server info: ${errorText(err)}`);
    }
  }

  await seedActivities();
  await refreshSessions();

  await new Promise<void>((resolve) => server.listen(args.port, args.host, resolve));
  if (serviceInfo) console.log(`[bridge] OpenCode ${serviceInfo.version ?? ''} at ${serviceInfo.url}`);
  if (roots.codex) console.log(`[bridge] Codex CLI transcripts at ${roots.codex}`);
  if (roots.claude) console.log(`[bridge] Claude Code transcripts at ${roots.claude}`);
  console.log(`[bridge] listening on ws://${args.host}:${args.port}  (health: http://${args.host}:${args.port}/health)`);
  console.log(
    `[bridge] ${latestSessions.length} session(s) · ${latestRunning} running · ${fmtTokens(latestTotals.tokens)} tokens`,
  );

  setInterval(() => {
    if (wss.clients.size > 0) void refreshSessions();
  }, 3000).unref();

  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    console.log('[bridge] shutting down');
    for (const ws of wss.clients) ws.close(1001, 'bridge shutdown');
    wss.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  if (client) void resubscribe(client);
}

main().catch((err) => {
  console.error(`[bridge] fatal: ${errorText(err)}`);
  process.exit(1);
});
