/**
 * File-based agent sources: Codex CLI and Claude Code.
 *
 * Both tools persist every session as JSONL transcripts on disk:
 *   - Codex CLI     -> $CODEX_HOME (default ~/.codex) / sessions/&lt;date&gt;/rollout-*.jsonl
 *   - Claude Code   -> $CLAUDE_CONFIG_DIR (default ~/.claude) / projects/&lt;dir&gt;/*.jsonl
 *
 * This module tails those files incrementally (append-only offsets, so multi-MB
 * transcripts are never re-read), derives live session summaries (title, model,
 * tokens, running state) and maps newly appended records to dashboard events.
 *
 * Read-only by design: nothing is ever written back to either tool.
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type FileSourceId = 'codex' | 'claude';

export type WireType = 'THOUGHT' | 'TOOL' | 'BASH' | 'SUCCESS' | 'INFO' | 'USER' | 'ASSISTANT';

export interface FileSessionEvent {
  source: FileSourceId;
  sessionID: string;
  type: WireType;
  message: string;
  tool?: string;
}

export interface FileSessionSummary {
  /** Namespaced id, e.g. `codex:rollout-...` / `claude:<uuid>`. */
  id: string;
  source: FileSourceId;
  title: string;
  directory: string;
  model?: { providerID: string; modelID: string; label: string };
  tokens: number;
  created: number;
  updated: number;
  running: boolean;
  lastEventType?: WireType;
  lastEventText?: string;
  lastEventAt?: number;
}

interface TailCache {
  offset: number;
  partial: string;
  title: string;
  directory: string;
  modelID: string;
  created: number;
  updated: number;
  /** Cumulative token totals kept across polls. */
  tokens: number;
  lastEventType?: WireType;
  lastEventText?: string;
  lastEventAt?: number;
  /** Codex token_count reports a cumulative total; remember the last value. */
  codexTotalTokens?: number;
}

const RUNNING_WINDOW_MS = 15_000;
const WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_BYTES_PER_POLL = 2_000_000;

/** Strip ANSI colour codes and control characters, collapse whitespace. */
function cleanText(value: string, max: number): string {
  const esc = String.fromCharCode(27);
  const parts = value.split(esc);
  let text = '';
  for (let i = 0; i < parts.length; i++) {
    let part = parts[i] ?? '';
    if (i > 0) {
      const match = /^\[[0-9;]*m/.exec(part);
      part = match ? part.slice(match[0].length) : part;
    }
    text += part;
  }
  let out = '';
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code < 32 || code === 127) {
      if (ch === '\n' || ch === '\t') out += ' ';
      continue;
    }
    out += ch;
  }
  out = out.replace(/\s+/g, ' ').trim();
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function parseTimestamp(value: unknown): number {
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000;
  }
  return 0;
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (!item || typeof item !== 'object') continue;
      const entry = item as Record<string, unknown>;
      const text = entry['text'] ?? entry['thinking'];
      if (typeof text === 'string') parts.push(text);
    }
    return parts.join('\n');
  }
  return '';
}

function summarizeInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const i = input as Record<string, unknown>;
  const keys = ['command', 'cmd', 'file_path', 'filePath', 'path', 'pattern', 'url', 'query', 'description', 'prompt', 'skill'];
  for (const key of keys) {
    if (typeof i[key] === 'string' && i[key]) return cleanText(i[key], 140);
  }
  return '';
}

function dirBaseName(dir: string): string {
  return dir.split(/[\\/]/).filter(Boolean).pop() ?? '';
}

function listFiles(dir: string, depth: number, accept: (name: string) => boolean, out: string[]): void {
  if (depth > 4 || out.length > 200) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, depth + 1, accept, out);
    else if (entry.isFile() && accept(entry.name)) out.push(full);
  }
}

/* ------------------------------------------------------------------ reader */

class JsonlTailer {
  private readonly cache = new Map<string, TailCache>();

  private cacheFor(file: string, birthMs: number): TailCache {
    let entry = this.cache.get(file);
    if (!entry) {
      entry = { offset: 0, partial: '', title: '', directory: '', modelID: '', created: birthMs, updated: birthMs, tokens: 0 };
      this.cache.set(file, entry);
    }
    return entry;
  }

  /** Drop caches for files that disappeared. */
  prune(live: Set<string>): void {
    for (const key of [...this.cache.keys()]) {
      if (!live.has(key)) this.cache.delete(key);
    }
  }

  /**
   * Read newly appended bytes of a JSONL file and feed each complete line to
   * `onLine`. Returns the cache entry (title, tokens, last event, ...).
   */
  tail(file: string, onLine: (entry: TailCache, line: Record<string, unknown>) => void): TailCache | null {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      this.cache.delete(file);
      return null;
    }
    const entry = this.cacheFor(file, stat.birthtimeMs || stat.mtimeMs);
    if (stat.size <= entry.offset) return entry;

    try {
      let chunk = '';
      const fd = fs.openSync(file, 'r');
      try {
        const length = Math.min(stat.size - entry.offset, MAX_BYTES_PER_POLL);
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, entry.offset);
        entry.offset += length;
        chunk = entry.partial + buffer.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }

      const lines = chunk.split('\n');
      entry.partial = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          continue;
        }
        try {
          onLine(entry, parsed);
        } catch {
          /* one bad record never breaks the source */
        }
      }
      if (entry.offset < stat.size) {
        // File grew beyond the per-poll cap; the partial line may be huge.
        entry.partial = '';
        entry.offset = stat.size;
      }
    } catch {
      return null;
    }
    return entry;
  }
}

/* ------------------------------------------------------------------ codex */

class CodexReader {
  private readonly tailer = new JsonlTailer();

  poll(): FileSessionSummary[] {
    const root = process.env['CODEX_HOME'] ?? path.join(os.homedir(), '.codex');
    const sessionsDir = path.join(root, 'sessions');
    try {
      fs.statSync(sessionsDir);
    } catch {
      this.tailer.prune(new Set());
      return [];
    }
    const files: string[] = [];
    listFiles(sessionsDir, 0, (name) => name.startsWith('rollout-') && name.endsWith('.jsonl'), files);

    const now = Date.now();
    const live = new Set<string>();
    const sessions: FileSessionSummary[] = [];

    for (const file of files) {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      if (now - stat.mtimeMs > WINDOW_MS) continue;
      live.add(file);

      const id = `codex:${path.basename(file, '.jsonl')}`;
      const entry = this.tailer.tail(file, (cache, record) => {
        const type = typeof record['type'] === 'string' ? (record['type'] as string) : '';
        const payload = (record['payload'] ?? {}) as Record<string, unknown>;
        const ts = parseTimestamp(record['timestamp'] ?? payload['timestamp']) || stat.mtimeMs;
        if (!cache.created || ts < cache.created) cache.created = ts;
        if (ts > cache.updated) cache.updated = ts;

        if (type === 'session_meta') {
          if (typeof payload['cwd'] === 'string') cache.directory = payload['cwd'];
          return;
        }
        if (type === 'turn_context') {
          if (typeof payload['model'] === 'string') cache.modelID = payload['model'];
          return;
        }
        if (type === 'response_item') {
          const kind = payload['type'];
          if (kind === 'message') {
            const role = payload['role'];
            const text = textFromContent(payload['content']);
            if (!text.trim()) return;
            if (role === 'user') {
              if (!cache.title) cache.title = cleanText(text, 64);
              cache.lastEventType = 'USER';
              cache.lastEventText = cleanText(text, 220);
              cache.lastEventAt = ts;
            }
          } else if (kind === 'function_call' && typeof payload['name'] === 'string') {
            let args: unknown = payload['arguments'];
            if (typeof args === 'string') {
              try {
                args = JSON.parse(args) as unknown;
              } catch {
                args = { command: args };
              }
            }
            const summary = summarizeInput(args);
            cache.lastEventType = 'TOOL';
            cache.lastEventText = `${payload['name']}${summary ? ` · ${summary}` : ''}`;
            cache.lastEventAt = ts;
          }
          return;
        }
        if (type !== 'event_msg') return;
        const kind = typeof payload['type'] === 'string' ? (payload['type'] as string) : '';
        if (kind === 'token_count') {
          const info = (payload['info'] ?? {}) as Record<string, unknown>;
          const totals = (info['total_token_usage'] ?? {}) as Record<string, unknown>;
          const total = num(totals['total_tokens']) || num(totals['input_tokens']) + num(totals['output_tokens']);
          if (total > 0) cache.codexTotalTokens = total;
          return;
        }
        if (kind === 'agent_reasoning') {
          const text = cleanText(String(payload['text'] ?? ''), 240);
          if (text) {
            cache.lastEventType = 'THOUGHT';
            cache.lastEventText = text;
            cache.lastEventAt = ts;
          }
          return;
        }
        if (kind === 'agent_message') {
          const text = cleanText(String(payload['message'] ?? ''), 240);
          if (text) {
            cache.lastEventType = 'ASSISTANT';
            cache.lastEventText = text;
            cache.lastEventAt = ts;
          }
          return;
        }
        if (kind === 'user_message') {
          const text = cleanText(String(payload['message'] ?? ''), 240);
          if (!text) return;
          if (!cache.title) cache.title = cleanText(text, 64);
          cache.lastEventType = 'USER';
          cache.lastEventText = text;
          cache.lastEventAt = ts;
          return;
        }
        if (kind === 'command_execution' || kind === 'mcp_tool_call') {
          const name = cleanText(String(payload['command'] ?? payload['tool'] ?? kind), 60);
          cache.lastEventType = 'TOOL';
          cache.lastEventText = name;
          cache.lastEventAt = ts;
          return;
        }
        if (kind === 'task_complete') {
          cache.lastEventType = 'SUCCESS';
          cache.lastEventText = cleanText(String(payload['last_agent_message'] ?? 'Turn complete'), 200) || 'Turn complete';
          cache.lastEventAt = ts;
        }
      });
      if (!entry) continue;

      const updated = Math.max(entry.updated, stat.mtimeMs);
      sessions.push({
        id,
        source: 'codex',
        title: entry.title || dirBaseName(entry.directory) || 'Codex session',
        directory: entry.directory,
        model: entry.modelID
          ? { providerID: 'openai', modelID: entry.modelID, label: `openai/${entry.modelID}` }
          : undefined,
        tokens: entry.codexTotalTokens ?? entry.tokens,
        created: entry.created || stat.birthtimeMs || stat.mtimeMs,
        updated,
        running: now - stat.mtimeMs <= RUNNING_WINDOW_MS,
        lastEventType: entry.lastEventType,
        lastEventText: entry.lastEventText,
        lastEventAt: entry.lastEventAt,
      });
    }

    this.tailer.prune(live);
    return sessions.sort((a, b) => b.updated - a.updated);
  }
}

/* ----------------------------------------------------------------- claude */

class ClaudeReader {
  private readonly tailer = new JsonlTailer();

  poll(): FileSessionSummary[] {
    const root = process.env['CLAUDE_CONFIG_DIR'] ?? path.join(os.homedir(), '.claude');
    const projectsDir = path.join(root, 'projects');
    try {
      fs.statSync(projectsDir);
    } catch {
      this.tailer.prune(new Set());
      return [];
    }
    const files: string[] = [];
    listFiles(projectsDir, 0, (name) => name.endsWith('.jsonl'), files);

    const now = Date.now();
    const live = new Set<string>();
    const sessions: FileSessionSummary[] = [];

    for (const file of files) {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      if (now - stat.mtimeMs > WINDOW_MS) continue;
      live.add(file);

      const id = `claude:${path.basename(file, '.jsonl')}`;
      const entry = this.tailer.tail(file, (cache, record) => {
        const type = typeof record['type'] === 'string' ? (record['type'] as string) : '';
        const ts = parseTimestamp(record['timestamp']) || stat.mtimeMs;
        if (!cache.created || ts < cache.created) cache.created = ts;
        if (ts > cache.updated) cache.updated = ts;
        if (typeof record['cwd'] === 'string' && !cache.directory) cache.directory = record['cwd'];

        if (type === 'summary') {
          const summary = typeof record['summary'] === 'string' ? record['summary'] : '';
          if (summary) cache.title = cleanText(summary, 64);
          return;
        }

        const message = (record['message'] ?? {}) as Record<string, unknown>;
        if (type === 'assistant') {
          if (typeof message['model'] === 'string') cache.modelID = message['model'];
          const usage = (message['usage'] ?? {}) as Record<string, unknown>;
          const added =
            num(usage['input_tokens']) +
            num(usage['output_tokens']) +
            num(usage['cache_read_input_tokens']) +
            num(usage['cache_creation_input_tokens']);
          if (added > 0) cache.tokens += added;
          const content = Array.isArray(message['content']) ? (message['content'] as Record<string, unknown>[]) : [];
          for (const block of content) {
            const kind = block['type'];
            if (kind === 'thinking') {
              const text = cleanText(String(block['thinking'] ?? ''), 240);
              if (text) {
                cache.lastEventType = 'THOUGHT';
                cache.lastEventText = text;
                cache.lastEventAt = ts;
              }
            } else if (kind === 'text') {
              const text = cleanText(String(block['text'] ?? ''), 240);
              if (text) {
                cache.lastEventType = 'ASSISTANT';
                cache.lastEventText = text;
                cache.lastEventAt = ts;
              }
            } else if (kind === 'tool_use') {
              const name = typeof block['name'] === 'string' ? block['name'] : 'tool';
              const summary = summarizeInput(block['input']);
              cache.lastEventType = 'TOOL';
              cache.lastEventText = `${name}${summary ? ` · ${summary}` : ''}`;
              cache.lastEventAt = ts;
            }
          }
          return;
        }

        if (type !== 'user') return;
        const content = message['content'];
        if (Array.isArray(content)) {
          for (const block of content as Record<string, unknown>[]) {
            if (block?.['type'] === 'tool_result') {
              cache.lastEventType = 'SUCCESS';
              cache.lastEventText = `tool result · ${cleanText(textFromContent(block['content']), 160)}`;
              cache.lastEventAt = ts;
            }
          }
          return;
        }
        const text = cleanText(String(content ?? ''), 240);
        if (!text || text.startsWith('<')) return; // slash-command wrappers, etc.
        if (!cache.title) cache.title = cleanText(text, 64);
        cache.lastEventType = 'USER';
        cache.lastEventText = text;
        cache.lastEventAt = ts;
      });
      if (!entry) continue;

      const updated = Math.max(entry.updated, stat.mtimeMs);
      sessions.push({
        id,
        source: 'claude',
        title: entry.title || dirBaseName(entry.directory) || 'Claude session',
        directory: entry.directory,
        model: entry.modelID
          ? { providerID: 'anthropic', modelID: entry.modelID, label: `anthropic/${entry.modelID}` }
          : undefined,
        tokens: entry.tokens,
        created: entry.created || stat.birthtimeMs || stat.mtimeMs,
        updated,
        running: now - stat.mtimeMs <= RUNNING_WINDOW_MS,
        lastEventType: entry.lastEventType,
        lastEventText: entry.lastEventText,
        lastEventAt: entry.lastEventAt,
      });
    }

    this.tailer.prune(live);
    return sessions.sort((a, b) => b.updated - a.updated);
  }
}

/* ------------------------------------------------------------------ facade */

export interface FileSourcesOptions {
  codex?: boolean;
  claude?: boolean;
}

export class FileSources extends EventEmitter {
  private readonly codex = new CodexReader();
  private readonly claude = new ClaudeReader();
  private readonly enabled: { codex: boolean; claude: boolean };
  /** Event keys already broadcast, to avoid duplicates across polls. */
  private readonly seenEvents = new Set<string>();
  private readonly lastState = new Map<string, { type?: WireType; text?: string }>();

  constructor(options: FileSourcesOptions = {}) {
    super();
    this.enabled = {
      codex: options.codex !== false,
      claude: options.claude !== false,
    };
  }

  /** Roots used for detection (reported by /health). */
  roots(): { codex: string | null; claude: string | null } {
    const codexRoot = process.env['CODEX_HOME'] ?? path.join(os.homedir(), '.codex');
    const claudeRoot = process.env['CLAUDE_CONFIG_DIR'] ?? path.join(os.homedir(), '.claude');
    const has = (dir: string): boolean => {
      try {
        fs.accessSync(dir);
        return true;
      } catch {
        return false;
      }
    };
    return {
      codex: this.enabled.codex && has(path.join(codexRoot, 'sessions')) ? codexRoot : null,
      claude: this.enabled.claude && has(path.join(claudeRoot, 'projects')) ? claudeRoot : null,
    };
  }

  poll(): FileSessionSummary[] {
    const sessions: FileSessionSummary[] = [];
    if (this.enabled.codex) sessions.push(...this.codex.poll());
    if (this.enabled.claude) sessions.push(...this.claude.poll());

    // Broadcast fresh tail events exactly once.
    for (const session of sessions) {
      if (!session.lastEventText || !session.lastEventType) continue;
      const key = `${session.id}:${session.lastEventAt ?? 0}:${session.lastEventType}`;
      if (this.seenEvents.has(key)) continue;
      const previous = this.lastState.get(session.id);
      if (previous && previous.text === session.lastEventText && previous.type === session.lastEventType) {
        this.seenEvents.add(key);
        continue;
      }
      this.seenEvents.add(key);
      this.lastState.set(session.id, { type: session.lastEventType, text: session.lastEventText });
      const event: FileSessionEvent = {
        source: session.source,
        sessionID: session.id,
        type: session.lastEventType,
        message: session.lastEventText,
      };
      if (session.lastEventType === 'TOOL') {
        const tool = session.lastEventText.split('·')[0]?.trim();
        if (tool) event.tool = tool;
      }
      this.emit('event', event);
    }
    if (this.seenEvents.size > 4000) {
      // Bounded memory: keep the newest half.
      const kept = [...this.seenEvents].slice(-2000);
      this.seenEvents.clear();
      kept.forEach((k) => this.seenEvents.add(k));
    }
    return sessions;
  }
}
