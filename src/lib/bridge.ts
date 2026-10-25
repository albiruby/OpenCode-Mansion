import { AGENTS } from '../data/agents';
import { LOG_TYPES } from '../types';
import { appState, bus, logStore, sessionStore } from '../store/store';
import type {
  AgentId,
  HistoryMessage,
  LogType,
  RealFileDiff,
  SessionActivity,
  SessionModel,
  SessionSummary,
  SessionTotals,
} from '../types';

export const DEFAULT_BRIDGE_URL = 'ws://127.0.0.1:4040';

const MAX_MESSAGE_LEN = 4000;
let ws: WebSocket | null = null;
let reconnectTimer: number | null = null;
let attempts = 0;
let manualClose = false;
let currentUrl = DEFAULT_BRIDGE_URL;
let everConnected = false;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: number;
}
const pending = new Map<string, PendingRequest>();

/* ---------------------------------------------------------------- parsing */
function str(value: unknown, max = 500): string | undefined {
  return typeof value === 'string' ? value.slice(0, max) : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isAgentId(value: unknown): value is AgentId {
  return typeof value === 'string' && value in AGENTS;
}

function isLogType(value: unknown): value is LogType {
  return typeof value === 'string' && (LOG_TYPES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function parseActivity(value: unknown): SessionActivity | undefined {
  if (!isRecord(value)) return undefined;
  const type = value['type'];
  const text = str(value['text'], 600);
  const at = num(value['at']);
  if (!isLogType(type) || !text) return undefined;
  return { type, text, at: at ?? Date.now() };
}

function parseModel(value: unknown): SessionModel | undefined {
  if (!isRecord(value)) return undefined;
  const providerID = str(value['providerID'], 80);
  const modelID = str(value['modelID'] ?? value['id'], 120);
  const label = str(value['label'], 160) ?? (providerID && modelID ? `${providerID}/${modelID}` : undefined);
  if (!label) return undefined;
  return { providerID: providerID ?? '', modelID: modelID ?? '', label };
}

function parseSession(value: unknown): SessionSummary | null {
  if (!isRecord(value)) return null;
  const id = str(value['id'], 120);
  if (!id) return null;
  const persona = isAgentId(value['persona']) ? value['persona'] : null;
  if (!persona) return null;
  const statusRaw = value['status'];
  const status = statusRaw === 'running' || statusRaw === 'failed' ? statusRaw : 'idle';
  const title = str(value['title'], 180) ?? 'Untitled session';
  const directory = str(value['directory'], 300) ?? '';
  const outcome = str(value['outcome'], 40);
  const activity = parseActivity(value['activity']);
  return {
    id,
    title,
    directory,
    persona,
    agent: str(value['agent'], 60),
    model: parseModel(value['model']),
    status,
    outcome,
    tokens: num(value['tokens']) ?? 0,
    cost: num(value['cost']) ?? 0,
    created: num(value['created']) ?? 0,
    updated: num(value['updated']) ?? 0,
    idle: num(value['idle']),
    activity,
  };
}

interface ParsedSnapshot {
  sessions: SessionSummary[];
  totals: SessionTotals;
  running: number;
}

function parseSnapshot(msg: Record<string, unknown>): ParsedSnapshot | null {
  const list = msg['sessions'];
  if (!Array.isArray(list)) return null;
  const sessions = list.map(parseSession).filter((s): s is SessionSummary => s !== null);
  const totalsRaw = msg['totals'];
  const totals: SessionTotals = isRecord(totalsRaw)
    ? {
        tokens: num(totalsRaw['tokens']) ?? sessions.reduce((sum, s) => sum + s.tokens, 0),
        cost: num(totalsRaw['cost']) ?? sessions.reduce((sum, s) => sum + s.cost, 0),
      }
    : {
        tokens: sessions.reduce((sum, s) => sum + s.tokens, 0),
        cost: sessions.reduce((sum, s) => sum + s.cost, 0),
      };
  return {
    sessions,
    totals,
    running: num(msg['running']) ?? sessions.filter((s) => s.status === 'running').length,
  };
}

interface ParsedEvent {
  agent: AgentId | 'system';
  type: LogType;
  tool?: string;
  message: string;
  sessionId?: string;
  sessionTitle?: string;
}

function parseEvent(msg: Record<string, unknown>): ParsedEvent | null {
  const type = msg['type'];
  const message = str(msg['message'], MAX_MESSAGE_LEN);
  if (!isLogType(type) || !message) return null;
  return {
    agent: isAgentId(msg['agent']) ? msg['agent'] : 'system',
    type,
    tool: str(msg['tool'], 48),
    message,
    sessionId: str(msg['session'], 120),
    sessionTitle: str(msg['sessionTitle'], 180),
  };
}

/* -------------------------------------------------------------- ws lifecycle */
function clearReconnect(): void {
  if (reconnectTimer !== null) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function setOffline(): void {
  sessionStore.connected = false;
  bus.emit('connection:state', 'offline');
}

function scheduleReconnect(): void {
  if (manualClose) return;
  clearReconnect();
  const delay = Math.min(1500 * 2 ** Math.min(attempts, 3), 8000);
  reconnectTimer = window.setTimeout(() => open(), delay);
}

function open(): void {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  try {
    ws = new WebSocket(currentUrl);
  } catch {
    setOffline();
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    attempts = 0;
    manualClose = false;
    sessionStore.connected = true;
    bus.emit('connection:state', 'open');
    if (!everConnected) {
      everConnected = true;
      bus.emit('toast', 'Connected to OpenCode bridge');
    }
  };

  ws.onmessage = (e) => {
    if (typeof e.data !== 'string') return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(e.data) as Record<string, unknown>;
    } catch {
      return;
    }
    const kind = msg['kind'];

    if (kind === 'sessions') {
      const snapshot = parseSnapshot(msg);
      if (snapshot) sessionStore.apply(snapshot.sessions, snapshot.totals);
      return;
    }

    if (kind === 'response') {
      const id = str(msg['id'], 80);
      if (!id) return;
      const request = pending.get(id);
      if (!request) return;
      pending.delete(id);
      window.clearTimeout(request.timer);
      if (msg['ok'] === true) request.resolve(msg['data']);
      else request.reject(new Error(str(msg['error'], 300) ?? 'Bridge request failed'));
      return;
    }

    if (kind === 'hello') {
      bus.emit('bridge:hello', {
        bridge: str(msg['bridge'], 40),
        service: msg['service'],
      });
      return;
    }

    if (kind === 'event' || kind === undefined) {
      const event = parseEvent(msg);
      if (!event) return;
      logStore.push({
        agent: event.agent,
        type: event.type,
        tool: event.tool,
        message: event.message,
        sessionId: event.sessionId,
        sessionTitle: event.sessionTitle,
      });

      if (event.agent !== 'system') {
        const ag = AGENTS[event.agent];
        ag.bubbleText = event.message.slice(0, 90);
        ag.currentTask = event.message.slice(0, 180);
        if (event.tool) ag.tool = event.tool;
        ag.state =
          event.type === 'TOOL' || event.type === 'BASH' || event.type === 'ASSISTANT'
            ? 'TYPING'
            : event.type === 'SUCCESS'
              ? 'TESTING'
              : 'PLANNING';
        bus.emit('agent:update', event.agent);
      }
    }
  };

  ws.onerror = () => {
    /* onclose handles recovery */
  };

  ws.onclose = () => {
    ws = null;
    setOffline();
    if (!manualClose) {
      attempts += 1;
      bus.emit('connection:state', attempts > 2 ? 'offline' : 'retrying');
      scheduleReconnect();
    }
  };
}

/* ------------------------------------------------------------------- public */
export function connectBridge(url: string): void {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    bus.emit('toast', 'Invalid WebSocket URL');
    return;
  }
  if (target.protocol !== 'ws:' && target.protocol !== 'wss:') {
    bus.emit('toast', 'Only ws:// and wss:// URLs are supported');
    return;
  }
  manualClose = false;
  attempts = 0;
  currentUrl = target.toString();
  appState.bridgeUrl = currentUrl;
  clearReconnect();
  if (ws) {
    const sock = ws;
    ws = null;
    sock.onclose = null;
    try {
      sock.close();
    } catch {
      /* noop */
    }
  }
  bus.emit('connection:state', 'connecting');
  open();
}

export function autoConnectBridge(): void {
  manualClose = false;
  currentUrl = appState.bridgeUrl;
  bus.emit('connection:state', 'connecting');
  open();
}

export function disconnectBridge(): void {
  manualClose = true;
  clearReconnect();
  if (ws) {
    const sock = ws;
    ws = null;
    sock.onclose = null;
    sock.onmessage = null;
    try {
      sock.close();
    } catch {
      /* noop */
    }
  }
  for (const [, request] of pending) {
    window.clearTimeout(request.timer);
    request.reject(new Error('Bridge disconnected'));
  }
  pending.clear();
  sessionStore.apply([], { tokens: 0, cost: 0 });
  setOffline();
}

/** Request a real session diff from the bridge. */
export function requestSessionDiff(sessionId: string): Promise<RealFileDiff[]> {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reject(new Error('Bridge is offline'));
      return;
    }
    const id = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const timer = window.setTimeout(() => {
      pending.delete(id);
      reject(new Error('Diff request timed out'));
    }, 12_000);
    pending.set(id, {
      resolve: (value) => {
        const files = Array.isArray(value) ? value : [];
        const parsed: RealFileDiff[] = [];
        files.forEach((raw) => {
          if (!isRecord(raw)) return;
          const file = str(raw['file'], 400);
          if (!file) return;
          const statusRaw = raw['status'];
          const status = statusRaw === 'added' || statusRaw === 'deleted' ? statusRaw : 'modified';
          parsed.push({
            file,
            patch: str(raw['patch'], 1_000_000) ?? '',
            additions: num(raw['additions']) ?? 0,
            deletions: num(raw['deletions']) ?? 0,
            status,
          });
        });
        resolve(parsed);
      },
      reject,
      timer,
    });
    ws.send(JSON.stringify({ kind: 'request', id, op: 'diff', sessionID: sessionId }));
  });
}

/** Request real reasoning/answer history for a session from the bridge. */
export interface HistoryResult {
  messages: HistoryMessage[];
  files: string[];
}

const historyCache = new Map<string, { at: number; promise: Promise<HistoryResult> }>();

export function requestSessionHistory(sessionId: string): Promise<HistoryResult> {
  const cached = historyCache.get(sessionId);
  if (cached && Date.now() - cached.at < 10_000) return cached.promise;
  const promise = requestHistoryRaw(sessionId);
  historyCache.set(sessionId, { at: Date.now(), promise });
  promise.catch(() => historyCache.delete(sessionId));
  return promise;
}

function requestHistoryRaw(sessionId: string): Promise<HistoryResult> {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reject(new Error('Bridge is offline'));
      return;
    }
    const id = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const timer = window.setTimeout(() => {
      pending.delete(id);
      reject(new Error('History request timed out'));
    }, 15_000);
    pending.set(id, {
      resolve: (value) => {
        const container = isRecord(value) ? value : {};
        const list = Array.isArray(container['messages']) ? container['messages'] : [];
        const messages: HistoryMessage[] = [];
        list.forEach((raw) => {
          if (!isRecord(raw)) return;
          const role = raw['role'] === 'user' ? 'user' : 'assistant';
          messages.push({
            id: str(raw['id'], 120) ?? `msg-${messages.length}`,
            role,
            at: num(raw['at']) ?? 0,
            text: str(raw['text'], 2000),
            reasoning: str(raw['reasoning'], 2000),
            tools: Array.isArray(raw['tools'])
              ? raw['tools']
                  .filter(isRecord)
                  .slice(0, 6)
                  .map((tool) => ({
                    name: str(tool['name'], 60) ?? 'tool',
                    status: str(tool['status'], 40),
                    summary: str(tool['summary'], 160),
                  }))
              : undefined,
          });
        });
        const files = Array.isArray(container['files'])
          ? container['files'].map((f) => str(f, 400)).filter((f): f is string => !!f)
          : [];
        resolve({ messages, files });
      },
      reject,
      timer,
    });
    ws.send(JSON.stringify({ kind: 'request', id, op: 'history', sessionID: sessionId }));
  });
}
