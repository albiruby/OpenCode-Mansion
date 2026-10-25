import type {
  AgentId,
  LogEntry,
  SessionSummary,
  SessionTotals,
  ViewId,
} from '../types';

type Handler = (payload: never) => void;

/** Minimal typed pub/sub event bus. */
class EventBus {
  private map = new Map<string, Set<Handler>>();

  on(event: string, fn: (payload: unknown) => void): void {
    let set = this.map.get(event);
    if (!set) {
      set = new Set();
      this.map.set(event, set);
    }
    set.add(fn as Handler);
  }

  emit(event: string, payload?: unknown): void {
    this.map.get(event)?.forEach((fn) => {
      try {
        (fn as (p: unknown) => void)(payload);
      } catch (err) {
        console.error(`[bus] handler for "${event}" failed`, err);
      }
    });
  }
}

export const bus = new EventBus();

/* --------------------------------------------------------------------------
   Log store — bounded real event stream
   -------------------------------------------------------------------------- */
const MAX_LOGS = 400;
const MAX_THOUGHTS = 80;

let nextId = 1;

export const logStore = {
  entries: [] as LogEntry[],
  thoughts: [] as LogEntry[],

  push(input: {
    agent: AgentId | 'system';
    type: LogEntry['type'];
    tool?: string;
    message: string;
    time?: number;
    sessionId?: string;
    sessionTitle?: string;
  }): LogEntry {
    const entry: LogEntry = {
      id: nextId++,
      time: input.time ?? Date.now(),
      agent: input.agent,
      type: input.type,
      tool: input.tool,
      message: input.message,
      sessionId: input.sessionId,
      sessionTitle: input.sessionTitle,
    };
    this.entries.push(entry);
    if (this.entries.length > MAX_LOGS) this.entries.shift();

    if (entry.type === 'THOUGHT') {
      this.thoughts.unshift(entry);
      if (this.thoughts.length > MAX_THOUGHTS) this.thoughts.pop();
      bus.emit('thought:new', entry);
    }

    bus.emit('log:new', entry);
    return entry;
  },

  clear(): void {
    this.entries = [];
    this.thoughts = [];
    bus.emit('logs:cleared');
  },
};

/* --------------------------------------------------------------------------
   Live sessions (single source of truth for session-centric UI)
   -------------------------------------------------------------------------- */
export const sessionStore = {
  sessions: [] as SessionSummary[],
  selectedId: null as string | null,
  totals: { tokens: 0, cost: 0 } as SessionTotals,
  running: 0,
  connected: false,

  apply(sessions: SessionSummary[], totals: SessionTotals): void {
    const previousSelection = this.selectedId;
    this.sessions = sessions;
    this.totals = totals;
    this.running = sessions.filter((s) => s.status === 'running').length;

    if (!sessions.some((s) => s.id === this.selectedId)) {
      this.selectedId = sessions[0]?.id ?? null;
    }

    bus.emit('sessions:update', { sessions: this.sessions, totals: this.totals, running: this.running });
    if (this.selectedId && this.selectedId !== previousSelection) {
      bus.emit('session:selected', this.selectedId);
    } else if (this.selectedId) {
      bus.emit('session:refresh', this.selectedId);
    }
  },

  select(id: string): void {
    if (!this.sessions.some((s) => s.id === id)) return;
    this.selectedId = id;
    bus.emit('session:selected', id);
    bus.emit('session:focus', id);
  },

  selected(): SessionSummary | null {
    return this.sessions.find((s) => s.id === this.selectedId) ?? null;
  },

  byPersona(persona: AgentId): SessionSummary | null {
    return this.sessions.find((s) => s.persona === persona) ?? null;
  },
};

/* --------------------------------------------------------------------------
   App-level mutable state
   -------------------------------------------------------------------------- */
export const appState = {
  selectedAgent: 'dylan' as AgentId,
  autoFollow: false as boolean,
  view: 'office' as ViewId,
  /** 3D office lighting is independent from the (always dark) dashboard UI. */
  officeDark: false as boolean,
  bridgeUrl: 'ws://127.0.0.1:4040',
};
