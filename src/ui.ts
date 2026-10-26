import { AGENTS, AGENT_IDS } from './data/agents';
import { appState, bus, logStore, sessionStore } from './store/store';
import { connectBridge, disconnectBridge, DEFAULT_BRIDGE_URL, requestSessionDiff, requestSessionHistory } from './lib/bridge';
import { rebuildForTheme, setCameraPreset, setSceneActive, setWorldTheme, getWorldThemeId, availableCameraPresets } from './lib/scene';
import { WORLD_THEMES, type WorldThemeId } from './lib/themes';
import { coffeeBreak } from './sim/engine';
import { isAudioEnabled, setAudioEnabled } from './lib/audio';
import type {
  AgentId,
  HistoryMessage,
  LogEntry,
  LogType,
  RealFileDiff,
  SessionSource,
  SessionSummary,
  ViewId,
} from './types';

/* ---------------------------------------------------------------- helpers */
const $ = <T extends HTMLElement = HTMLElement>(id: string): T | null =>
  document.getElementById(id) as T | null;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function agentLabel(entry: LogEntry): string {
  if (entry.agent === 'system') return 'SYS';
  return AGENTS[entry.agent]?.name ?? 'SYS';
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
}

function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1_000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  return `${(n / 1_000_000_000).toFixed(2)}B`;
}

function formatCost(cost: number): string {
  if (!Number.isFinite(cost)) return '0.00';
  return cost.toFixed(cost < 1 ? 3 : 2);
}

function timeAgo(ms: number): string {
  if (!ms) return 'unknown';
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function hexColor(n: number): string {
  return `#${n.toString(16).padStart(6, '0')}`;
}

function short(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const BADGE_CLASS: Record<LogType, string> = {
  THOUGHT: 'text-indigo-700 dark:text-indigo-300 bg-indigo-100 dark:bg-indigo-950/60',
  TOOL: 'text-sky-700 dark:text-sky-300 bg-sky-100 dark:bg-sky-950/60',
  BASH: 'text-amber-800 dark:text-amber-300 bg-amber-100 dark:bg-amber-950/60',
  SUCCESS: 'text-emerald-800 dark:text-emerald-300 bg-emerald-100 dark:bg-emerald-950/60',
  INFO: 'text-zinc-700 dark:text-zinc-300 bg-zinc-200/80 dark:bg-zinc-800',
  USER: 'text-violet-800 dark:text-violet-300 bg-violet-100 dark:bg-violet-950/60',
  ASSISTANT: 'text-blue-800 dark:text-blue-300 bg-blue-100 dark:bg-blue-950/60',
};

type FilterKey = 'all' | 'thoughts' | 'tools' | 'bash';

const FILTERS: Record<FilterKey, (e: LogEntry) => boolean> = {
  all: () => true,
  thoughts: (e) => e.type === 'THOUGHT',
  tools: (e) => e.type === 'TOOL',
  bash: (e) => e.type === 'BASH' || e.type === 'SUCCESS',
};

const TAB_KEYS: FilterKey[] = ['all', 'thoughts', 'tools', 'bash'];

function stateForActivity(session: SessionSummary): 'PLANNING' | 'TYPING' | 'TESTING' | 'IDLE' {
  if (session.status !== 'running') return 'IDLE';
  const type = session.activity?.type;
  if (type === 'TOOL' || type === 'BASH' || type === 'ASSISTANT') return 'TYPING';
  if (type === 'SUCCESS') return 'TESTING';
  return 'PLANNING';
}

/* ------------------------------------------------------------------ toast */
export function initToasts(): void {
  const box = $('toastBox');
  if (!box) return;
  bus.on('toast', (payload) => {
    const msg = String(payload ?? '').slice(0, 160);
    const toast = el(
      'div',
      'text-xs font-mono px-3 py-1.5 rounded-md bg-slate-100 text-slate-900 shadow-md border border-slate-300',
      msg,
    );
    box.appendChild(toast);
    window.setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.25s';
      window.setTimeout(() => toast.remove(), 250);
    }, 2500);
    while (box.children.length > 5) box.removeChild(box.firstChild as Node);
  });
}

/* ----------------------------------------------------------- header stats */
function initHeader(): void {
  const selector = $<HTMLSelectElement>('sessionSelector');
  const modeLabel = $('modeLabel');
  const dot = $('statusDot');

  function updateSelected(sessionId: string | null): void {
    const session = sessionStore.sessions.find((s) => s.id === sessionId) ?? null;
    const nameEl = $('sessionNameTag');
    const modelEl = $('modelTag');
    if (nameEl) nameEl.textContent = session ? session.title : 'No live session';
    if (modelEl) modelEl.textContent = session?.model?.label ?? '—';
    if (selector && session) selector.value = session.id;
  }

  bus.on('session:selected', (payload) => updateSelected(String(payload)));
  bus.on('session:refresh', (payload) => updateSelected(String(payload)));

  bus.on('sessions:update', (payload) => {
    const data = payload as { sessions: SessionSummary[]; totals: { tokens: number; cost: number }; running: number };
    const sessionCounter = $('sessionCounter');
    const tokenEl = $('tokenCounter');
    const costEl = $('costCounter');

    if (sessionCounter) {
      sessionCounter.textContent = `${data.sessions.length} session${data.sessions.length === 1 ? '' : 's'}`;
      sessionCounter.title = `${data.running} running`;
    }
    if (tokenEl) tokenEl.textContent = `${formatTokens(data.totals.tokens)} tokens`;
    if (costEl) costEl.textContent = formatCost(data.totals.cost);

    if (selector) {
      selector.innerHTML = '';
      if (data.sessions.length === 0) {
        const option = el('option', '', 'No live sessions');
        option.value = '';
        option.disabled = true;
        option.selected = true;
        selector.appendChild(option);
        selector.disabled = true;
      } else {
        selector.disabled = false;
        data.sessions.forEach((session) => {
          const option = el('option', '', `${session.title} · ${AGENTS[session.persona].name}`);
          option.value = session.id;
          selector.appendChild(option);
        });
        if (sessionStore.selectedId) selector.value = sessionStore.selectedId;
      }
    }

    if (!sessionStore.selectedId) updateSelected(null);
    else updateSelected(sessionStore.selectedId);
  });

  selector?.addEventListener('change', () => {
    if (selector.value) sessionStore.select(selector.value);
  });

  bus.on('connection:state', (payload) => {
    const state = String(payload);
    if (modeLabel) {
      modeLabel.textContent =
        state === 'open'
          ? 'Live Bridge'
          : state === 'connecting'
            ? 'Connecting…'
            : state === 'retrying'
              ? 'Reconnecting…'
              : 'Bridge Offline';
    }
    if (dot) {
      dot.className =
        state === 'open'
          ? 'w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse'
          : state === 'connecting' || state === 'retrying'
            ? 'w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse'
            : 'w-1.5 h-1.5 rounded-full bg-rose-500';
    }
    const pill = $('connectionPill');
    if (pill) {
      pill.className =
        state === 'open'
          ? 'inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-0.5 rounded-full bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800/60'
          : state === 'connecting' || state === 'retrying'
            ? 'inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-0.5 rounded-full bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-800/60'
            : 'inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-0.5 rounded-full bg-rose-50 dark:bg-rose-950/40 text-rose-800 dark:text-rose-300 border border-rose-200 dark:border-rose-800/60';
    }
  });

  // Sound
  const soundBtn = $('soundBtn');
  const volOn = $('iconVolumeOn');
  const volOff = $('iconVolumeOff');
  if (soundBtn && volOn && volOff) {
    soundBtn.addEventListener('click', () => {
      const next = !isAudioEnabled();
      setAudioEnabled(next);
      volOn.classList.toggle('hidden', !next);
      volOff.classList.toggle('hidden', next);
      soundBtn.setAttribute('aria-pressed', String(next));
      bus.emit('toast', next ? 'Audio feedback unmuted' : 'Audio feedback muted');
    });
  }

  $('themeBtn')?.addEventListener('click', () => {
    applyOfficeTheme(!appState.officeDark);
  });
}

/** The dashboard stays dark; this only relights the 3D office scene. */
export function applyOfficeTheme(isDark: boolean): void {
  appState.officeDark = isDark;
  window.localStorage.setItem('hq-office-theme', isDark ? 'dark' : 'light');
  const moon = $('iconMoon');
  const sun = $('iconSun');
  if (moon && sun) {
    moon.classList.toggle('hidden', !isDark);
    sun.classList.toggle('hidden', isDark);
  }
  rebuildForTheme(isDark);
}

export function initOfficeTheme(): void {
  const stored = window.localStorage.getItem('hq-office-theme') ?? window.localStorage.getItem('hq-theme');
  const isDark = stored ? stored !== 'light' : false;
  applyOfficeTheme(isDark);
}

/* ------------------------------------------------------------ speech tags */
function initSpeechBubbles(): void {
  const box = $('speechTagsContainer');
  if (!box) return;
  AGENT_IDS.forEach((id) => {
    const ag = AGENTS[id];
    const bubble = el('div', 'speech-bubble-3d opacity-0');
    bubble.id = `speech-${id}`;
    const inner = el(
      'div',
      'bg-white/95 dark:bg-zinc-900/95 text-slate-800 dark:text-zinc-200 text-[11px] font-sans px-2.5 py-1 rounded-md shadow-sm border border-slate-200 dark:border-zinc-700 flex items-center gap-1.5',
    );
    const dot = el('span', 'w-1.5 h-1.5 rounded-full');
    dot.style.backgroundColor = hexColor(ag.color);
    inner.appendChild(dot);
    const text = el('span', '', '');
    text.id = `speechText-${id}`;
    inner.appendChild(text);
    bubble.appendChild(inner);
    box.appendChild(bubble);
  });
}

/* ------------------------------------------------------------ log terminal */
function initLogPanel(): void {
  const box = $('terminalStreamBox');
  if (!box) return;
  let filterKey: FilterKey = 'all';
  let autoScroll = true;

  const makePlaceholder = (text: string): HTMLDivElement =>
    el('div', 'text-slate-500 dark:text-zinc-500 italic p-2 text-center', text);

  const entryNode = (e: LogEntry): HTMLDivElement => {
    const row = el('div', 'flex items-start gap-2 hover:bg-slate-100/70 dark:hover:bg-zinc-900/70 px-1.5 py-0.5 rounded');
    row.appendChild(el('span', 'text-slate-500 dark:text-zinc-500 shrink-0 select-none font-mono', formatTime(e.time)));
    const label = short(e.sessionTitle || agentLabel(e), 30);
    const badge = el(
      'span',
      `text-[10px] font-mono px-1.5 py-0.5 rounded shrink-0 ${BADGE_CLASS[e.type]}`,
      `[${label}:${e.type}]`,
    );
    if (e.sessionId) badge.title = `${e.sessionTitle ?? ''} (${e.sessionId})`;
    row.appendChild(badge);
    row.appendChild(el('span', 'text-slate-800 dark:text-zinc-200 break-all', e.message));
    return row;
  };

  const rebuild = (): void => {
    box.innerHTML = '';
    const visible = logStore.entries.filter(FILTERS[filterKey]);
    if (visible.length === 0) {
      box.appendChild(makePlaceholder('Waiting for live OpenCode events…'));
      return;
    }
    visible.slice(-250).forEach((e) => box.appendChild(entryNode(e)));
    if (autoScroll) box.scrollTop = box.scrollHeight;
  };

  bus.on('log:new', (payload) => {
    const e = payload as LogEntry;
    if (!FILTERS[filterKey](e)) return;
    const first = box.firstElementChild;
    if (box.children.length === 1 && first?.classList.contains('italic')) box.innerHTML = '';
    box.appendChild(entryNode(e));
    while (box.children.length > 250) box.removeChild(box.firstChild as Node);
    if (autoScroll) box.scrollTop = box.scrollHeight;
  });

  bus.on('logs:cleared', rebuild);

  TAB_KEYS.forEach((key) => {
    const btn = $(`logTab-${key}`);
    btn?.addEventListener('click', () => {
      filterKey = key;
      TAB_KEYS.forEach((k) => {
        const b = $(`logTab-${k}`);
        b?.setAttribute('aria-selected', String(k === key));
        if (b) {
          b.className =
            k === key
              ? 'text-xs px-2.5 py-1 rounded font-medium bg-slate-200 dark:bg-zinc-700 text-slate-900 dark:text-white transition'
              : 'text-xs px-2.5 py-1 rounded font-medium text-slate-600 hover:text-slate-900 dark:text-zinc-400 dark:hover:text-white transition';
        }
      });
      rebuild();
    });
  });

  $('clearLogBtn')?.addEventListener('click', () => {
    logStore.clear();
    bus.emit('toast', 'Event stream cleared');
  });

  const autoBtn = $('autoScrollBtn');
  autoBtn?.addEventListener('click', () => {
    autoScroll = !autoScroll;
    autoBtn.setAttribute('aria-pressed', String(autoScroll));
    autoBtn.classList.toggle('opacity-40', !autoScroll);
    bus.emit('toast', autoScroll ? 'Auto-scroll on' : 'Auto-scroll paused');
  });

  rebuild();
}

/* ----------------------------------------------------------- thought panel */
function initThoughtPanel(): void {
  const list = $('thoughtStreamList');
  if (!list) return;

  let history: HistoryMessage[] = [];
  let live: LogEntry[] = [];
  let loadedFor: string | null = null;
  let loading = false;

  const placeholder = (text: string): void => {
    list.innerHTML = '';
    list.appendChild(el('p', 'text-slate-500 dark:text-zinc-500 italic', text));
  };

  const card = (opts: {
    title: string;
    at: number;
    reasoning?: string;
    text?: string;
    tools?: { name: string; status?: string; summary?: string }[];
  }): HTMLDivElement => {
    const wrap = el('div', 'p-2 rounded-lg bg-slate-50 dark:bg-zinc-950 border border-slate-200 dark:border-zinc-800');
    const head = el('div', 'flex items-center justify-between gap-2 text-[10px] text-slate-600 dark:text-zinc-400 mb-1');
    head.appendChild(el('span', 'font-semibold text-slate-700 dark:text-zinc-300 truncate', opts.title));
    head.appendChild(el('span', 'shrink-0', formatTime(opts.at)));
    wrap.appendChild(head);

    if (opts.reasoning) {
      wrap.appendChild(
        el('span', 'inline-block text-[9px] font-mono px-1 py-0.5 rounded bg-indigo-100 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300 mb-1', 'THOUGHT'),
      );
      wrap.appendChild(el('p', 'text-slate-700 dark:text-zinc-300 whitespace-pre-wrap break-words', opts.reasoning));
    }
    if (opts.text) {
      wrap.appendChild(
        el('span', 'inline-block text-[9px] font-mono px-1 py-0.5 rounded bg-blue-100 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 mb-1 mt-1.5', 'ANSWER'),
      );
      wrap.appendChild(el('p', 'text-slate-700 dark:text-zinc-300 whitespace-pre-wrap break-words', opts.text));
    }
    if (opts.tools && opts.tools.length) {
      wrap.appendChild(
        el(
          'p',
          'text-[10px] font-mono text-slate-500 dark:text-zinc-500 mt-1 truncate',
          `tools: ${opts.tools.map((t) => t.name).join(', ')}`,
        ),
      );
    }
    return wrap;
  };

  const rebuild = (): void => {
    if (!sessionStore.selectedId) {
      placeholder('No live session selected.');
      return;
    }
    if (loading) {
      placeholder('Loading session history…');
      return;
    }
    const session = sessionStore.selected();
    const title = session ? `${AGENTS[session.persona].name} · ${short(session.title, 30)}` : 'Session';
    list.innerHTML = '';

    const seen = new Set<string>();
    history.forEach((h) => {
      if (h.text) seen.add(h.text.slice(0, 80));
      if (h.reasoning) seen.add(h.reasoning.slice(0, 80));
    });

    const liveCards = [...live]
      .reverse()
      .filter((e) => !seen.has(e.message.slice(0, 80)))
      .slice(0, 12)
      .map((e) => card({ title, at: e.time, reasoning: e.message }));

    const historyCards = history
      .filter((h) => h.role === 'assistant')
      .slice(-14)
      .reverse()
      .map((h) => card({ title, at: h.at, reasoning: h.reasoning, text: h.text, tools: h.tools }));

    const all = [...liveCards, ...historyCards];
    if (all.length === 0) {
      placeholder('No reasoning history in this session yet.');
      return;
    }
    all.slice(0, 24).forEach((node) => list.appendChild(node));
  };

  const load = async (sessionId: string, force = false): Promise<void> => {
    if (!force && loadedFor === sessionId) return;
    if (loading) return;
    loading = true;
    rebuild();
    try {
      history = (await requestSessionHistory(sessionId)).messages;
    } catch {
      history = [];
    } finally {
      loading = false;
      loadedFor = sessionId;
      rebuild();
    }
  };

  bus.on('session:selected', (payload) => {
    live = [];
    loadedFor = null;
    void load(String(payload));
  });
  bus.on('thought:new', (payload) => {
    const entry = payload as LogEntry;
    if (sessionStore.selectedId && entry.sessionId !== sessionStore.selectedId) return;
    live.push(entry);
    if (live.length > 30) live.shift();
    rebuild();
  });
  bus.on('logs:cleared', () => {
    live = [];
    rebuild();
  });
  bus.on('connection:state', (payload) => {
    if (String(payload) !== 'open') {
      history = [];
      live = [];
      loadedFor = null;
      rebuild();
    }
  });
  window.setInterval(() => {
    if (appState.view === 'activity' && sessionStore.selectedId) {
      void load(sessionStore.selectedId, true);
    }
  }, 15_000);

  rebuild();
}

/* -------------------------------------------------------------- diff panel */
function initDiffPanel(): void {
  const pills = $('filePillContainer');
  const nameEl = $('activeDiffFilename');
  const langEl = $('activeDiffLang');
  const addsEl = $('diffAdds');
  const delsEl = $('diffDels');
  const codeEl = $('diffCodeContent');
  const statsEl = $('diffStatsBadge');
  if (!pills || !nameEl || !langEl || !addsEl || !delsEl || !codeEl) return;

  let files: RealFileDiff[] = [];
  let touched: string[] = [];
  let selectedIndex = 0;
  let loadedFor: string | null = null;
  let loading = false;

  const languageFor = (file: string): string => {
    const ext = file.split('.').pop()?.toLowerCase() ?? '';
    const map: Record<string, string> = {
      ts: 'TypeScript',
      tsx: 'TSX',
      js: 'JavaScript',
      jsx: 'JSX',
      json: 'JSON',
      md: 'Markdown',
      css: 'CSS',
      html: 'HTML',
      py: 'Python',
      rs: 'Rust',
      go: 'Go',
      sql: 'SQL',
      prisma: 'Prisma',
      yml: 'YAML',
      yaml: 'YAML',
      sh: 'Shell',
    };
    return map[ext] ?? (ext ? ext.toUpperCase() : 'File');
  };

  const empty = (text: string): void => {
    pills.innerHTML = '';
    codeEl.innerHTML = '';
    codeEl.appendChild(el('span', 'text-slate-500 dark:text-zinc-500 italic', text));
    nameEl.textContent = '—';
    langEl.textContent = '—';
    addsEl.textContent = '+0';
    delsEl.textContent = '-0';
  };

  const select = (index: number): void => {
    const file = files[index];
    if (!file) return;
    selectedIndex = index;
    Array.from(pills.children).forEach((child, i) => {
      const btn = child as HTMLButtonElement;
      btn.setAttribute('aria-pressed', String(i === index));
      btn.className =
        i === index
          ? 'px-2 py-1 rounded text-[11px] border font-medium bg-slate-200 dark:bg-zinc-700 border-slate-300 dark:border-zinc-600 text-slate-900 dark:text-white transition'
          : 'px-2 py-1 rounded text-[11px] border bg-slate-100 dark:bg-zinc-800/80 border-slate-200 dark:border-zinc-700/60 text-slate-600 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-white transition';
    });
    nameEl.textContent = file.file;
    langEl.textContent = languageFor(file.file);
    addsEl.textContent = `+${file.additions}`;
    delsEl.textContent = `-${file.deletions}`;
    codeEl.innerHTML = '';
    const lines = file.patch.split('\n');
    if (!file.patch.trim()) {
      codeEl.appendChild(el('span', 'text-slate-500 dark:text-zinc-500 italic', 'No patch content.'));
    } else {
      lines.slice(0, 400).forEach((line) => {
        const cls = line.startsWith('+')
          ? 'text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/30 block'
          : line.startsWith('-')
            ? 'text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-950/30 block'
            : line.startsWith('@@')
              ? 'text-sky-700 dark:text-sky-300 block'
              : 'text-slate-700 dark:text-zinc-300 block';
        codeEl.appendChild(el('span', cls, line || ' '));
      });
    }
  };

  const selectTouched = (index: number): void => {
    const file = touched[index];
    if (!file) return;
    Array.from(pills.children).forEach((child, i) => {
      const btn = child as HTMLButtonElement;
      btn.setAttribute('aria-pressed', String(i === index));
      btn.className =
        i === index
          ? 'px-2 py-1 rounded text-[11px] border font-medium bg-slate-200 dark:bg-zinc-700 border-slate-300 dark:border-zinc-600 text-slate-900 dark:text-white transition'
          : 'px-2 py-1 rounded text-[11px] border bg-slate-100 dark:bg-zinc-800/80 border-slate-200 dark:border-zinc-700/60 text-slate-600 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-white transition';
    });
    nameEl.textContent = file;
    langEl.textContent = languageFor(file);
    addsEl.textContent = '+0';
    delsEl.textContent = '-0';
    codeEl.innerHTML = '';
    codeEl.appendChild(
      el(
        'span',
        'text-amber-700 dark:text-amber-400 block',
        'No patch available — this file was written/edited in the session, but the working tree has no uncommitted diff.',
      ),
    );
  };

  const renderTouched = (): void => {
    pills.innerHTML = '';
    touched.forEach((file, index) => {
      const btn = el('button', 'px-2 py-1 rounded text-[11px] border', short(file.split(/[\\/]/).pop() ?? file, 24));
      btn.type = 'button';
      btn.title = file;
      btn.addEventListener('click', () => selectTouched(index));
      pills.appendChild(btn);
    });
    selectTouched(0);
  };

  const render = (): void => {
    pills.innerHTML = '';
    if (files.length === 0) {
      empty('No uncommitted changes for this session.');
      return;
    }
    files.forEach((file, index) => {
      const btn = el('button', 'px-2 py-1 rounded text-[11px] border', short(file.file.split('/').pop() ?? file.file, 24));
      btn.type = 'button';
      btn.title = file.file;
      btn.addEventListener('click', () => select(index));
      pills.appendChild(btn);
    });
    select(Math.min(selectedIndex, files.length - 1));
  };

  const load = async (sessionId: string, force = false): Promise<void> => {
    if (!force && loadedFor === sessionId) return;
    if (loading) return;
    loading = true;
    loadedFor = sessionId;
    files = [];
    touched = [];
    empty('Loading diff…');
    try {
      files = await requestSessionDiff(sessionId);
      if (files.length === 0) {
        try {
          touched = (await requestSessionHistory(sessionId)).files;
        } catch {
          touched = [];
        }
        if (touched.length) {
          renderTouched();
        } else {
          empty('No uncommitted changes for this session.');
        }
        return;
      }
      selectedIndex = 0;
      render();
    } catch (err) {
      files = [];
      touched = [];
      const message = err instanceof Error ? err.message : 'Failed to load diff';
      empty(message === 'Bridge is offline' ? 'Bridge offline — start `npm run bridge`.' : message);
    } finally {
      loading = false;
    }
  };

  bus.on('session:selected', (payload) => {
    loadedFor = null;
    void load(String(payload));
  });

  bus.on('connection:state', (payload) => {
    if (String(payload) !== 'open') {
      files = [];
      touched = [];
      loadedFor = null;
      empty('Bridge offline — start `npm run bridge`.');
    }
  });

  window.setInterval(() => {
    if (appState.view === 'activity' && sessionStore.selectedId) {
      void load(sessionStore.selectedId, true);
    }
  }, 15_000);

  const selected = sessionStore.selected();
  if (selected) void load(selected.id);
  else empty('Select a live session to see its changes.');
  if (statsEl) statsEl.title = 'Additions / deletions of the selected file';
}

/* ------------------------------------------------------- source badge */
const SOURCE_INFO: Record<Exclude<SessionSource, 'opencode'>, { label: string; chip: string; color: string }> = {
  codex: { label: 'Codex CLI', chip: 'CX', color: '#f59e0b' },
  claude: { label: 'Claude Code', chip: 'CC', color: '#fb923c' },
};

function sourceInfo(session: SessionSummary): { label: string; chip: string; color: string } | null {
  if (!session.source || session.source === 'opencode') return null;
  return SOURCE_INFO[session.source] ?? null;
}

function sourceChip(session: SessionSummary): HTMLSpanElement | null {
  const info = sourceInfo(session);
  if (!info) return null;
  const chip = el('span', 'shrink-0 rounded px-1 font-mono text-[9px] leading-4', info.chip);
  chip.style.color = info.color;
  chip.style.border = `1px solid ${info.color}66`;
  chip.title = info.label;
  return chip;
}

/* ------------------------------------------------------- session tabs bar */
function initSessionTabs(): void {
  const tabs = $('sessionTabs');
  const summary = $('sessionSummary');
  if (!tabs) return;

  const render = (): void => {
    tabs.innerHTML = '';
    if (sessionStore.sessions.length === 0) {
      tabs.appendChild(
        el(
          'span',
          'text-xs text-slate-500 dark:text-zinc-500 italic',
          'No live sessions — run `npm run bridge`',
        ),
      );
      if (summary) summary.textContent = 'Bridge offline';
      return;
    }
    sessionStore.sessions.forEach((session) => {
      const active = session.id === sessionStore.selectedId;
      const btn = el(
        'button',
        `flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs whitespace-nowrap border transition ${
          active
            ? 'bg-slate-200 dark:bg-zinc-700 border-slate-300 dark:border-zinc-600 text-slate-900 dark:text-white'
            : 'bg-white dark:bg-zinc-900 border-slate-200 dark:border-zinc-800 text-slate-600 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-white'
        }`,
      );
      btn.type = 'button';
      btn.id = `sessionTab-${session.id}`;
      btn.setAttribute('aria-pressed', String(active));
      const dot = el('span', 'w-1.5 h-1.5 rounded-full shrink-0');
      dot.style.backgroundColor =
        session.status === 'running' ? '#10b981' : session.status === 'failed' ? '#f43f5e' : '#71717a';
      btn.appendChild(dot);
      btn.appendChild(el('span', 'font-mono opacity-70', AGENTS[session.persona].name));
      btn.appendChild(el('span', 'max-w-[16rem] truncate', session.title));
      const chip = sourceChip(session);
      if (chip) btn.appendChild(chip);
      btn.addEventListener('click', () => sessionStore.select(session.id));
      tabs.appendChild(btn);
    });
    if (summary) {
      summary.textContent = `${sessionStore.sessions.length} sessions · ${sessionStore.running} running · ${
        Math.min(sessionStore.sessions.length, 6) * 9
      } agents`;
    }
  };

  bus.on('sessions:update', render);
  bus.on('session:selected', render);
  render();
}

/* ------------------------------------------------------- session cards */
function initSessionPanel(): void {
  const grid = $('sessionGrid');
  if (!grid) return;

  const previouslyAssigned = new Set<AgentId>();

  const updateAgents = (): void => {
    const assigned = new Set<AgentId>();
    // Avatars are shared by many sessions (10 personas, up to 30 sessions), so
    // work out which personas a running session owns BEFORE touching any state —
    // an idle duplicate of the same persona must never clobber a working one.
    const runningPersonas = new Set<AgentId>();
    sessionStore.sessions.forEach((session) => {
      if (session.status === 'running') runningPersonas.add(session.persona);
    });
    sessionStore.sessions.forEach((session) => {
      const ag = AGENTS[session.persona];
      assigned.add(session.persona);
      if (runningPersonas.has(ag.id)) {
        if (session.status !== 'running' || ag.state === 'COFFEE') return;
        ag.state = stateForActivity(session);
        ag.bubbleText = short(session.title, 44);
      } else if (session.status !== 'running') {
        ag.bubbleText = '';
      }
      ag.currentTask = session.activity?.text ?? session.title;
      if (session.model?.label) ag.tool = session.model.label;
      bus.emit('agent:update', session.persona);
    });

    // Only reset agents that just lost their session — do not clobber the
    // scene's roaming moods (WALKING / COFFEE / TV) on every snapshot.
    previouslyAssigned.forEach((id) => {
      if (assigned.has(id)) return;
      const ag = AGENTS[id];
      ag.state = 'IDLE';
      ag.bubbleText = '';
      ag.currentTask = 'Waiting for a live session';
      ag.tool = '—';
      bus.emit('agent:update', id);
    });

    previouslyAssigned.clear();
    assigned.forEach((id) => previouslyAssigned.add(id));
  };

  const statusBadge = (session: SessionSummary): HTMLSpanElement => {
    const map: Record<string, string> = {
      running: 'bg-emerald-100 dark:bg-emerald-950/60 text-emerald-800 dark:text-emerald-300 border-emerald-300 dark:border-emerald-800',
      idle: 'bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 border-zinc-300 dark:border-zinc-700',
      failed: 'bg-rose-100 dark:bg-rose-950/60 text-rose-800 dark:text-rose-300 border-rose-300 dark:border-rose-800',
    };
    return el(
      'span',
      `text-[10px] font-mono px-1.5 py-0.5 rounded border ${map[session.status] ?? map['idle']}`,
      session.status.toUpperCase(),
    );
  };

  const render = (): void => {
    grid.innerHTML = '';
    updateAgents();

    if (sessionStore.sessions.length === 0) {
      const empty = el(
        'div',
        'p-6 text-center text-slate-500 dark:text-zinc-500 text-xs font-mono',
      );
      empty.appendChild(el('p', 'mb-1', 'No live sessions detected.'));
      empty.appendChild(el('p', '', 'Start the bridge: npm run bridge'));
      grid.appendChild(empty);
      return;
    }

    sessionStore.sessions.forEach((session) => {
      const ag = AGENTS[session.persona];
      const active = session.id === sessionStore.selectedId;
      const card = el(
        'button',
        `text-left p-3 bg-white dark:bg-zinc-900 hover:bg-slate-50 dark:hover:bg-zinc-800/70 transition cursor-pointer ${
          active ? 'ring-1 ring-inset ring-slate-400 dark:ring-zinc-500' : ''
        }`,
      );
      card.type = 'button';
      card.id = `sessionCard-${session.id}`;
      card.title = `${session.title}\n${session.directory}`;

      const top = el('div', 'flex items-center justify-between gap-2 mb-1');
      const left = el('div', 'flex items-center gap-1.5 min-w-0');
      const dot = el('span', 'w-2 h-2 rounded-full shrink-0');
      dot.style.backgroundColor = hexColor(ag.color);
      left.appendChild(dot);
      left.appendChild(el('span', 'font-semibold text-slate-800 dark:text-zinc-200 truncate', ag.name));
      const info = sourceInfo(session);
      left.appendChild(
        el(
          'span',
          `text-[10px] truncate ${info ? '' : 'text-slate-500 dark:text-zinc-500'}`,
          info ? info.label : session.agent ? `agent ${session.agent}` : '—',
        ),
      );
      const chip = sourceChip(session);
      if (chip) left.appendChild(chip);
      top.appendChild(left);
      top.appendChild(statusBadge(session));
      card.appendChild(top);

      card.appendChild(el('p', 'text-sm font-medium text-slate-900 dark:text-white leading-snug line-clamp-2', session.title));
      card.appendChild(
        el('p', 'text-[10px] font-mono text-slate-500 dark:text-zinc-500 truncate mt-0.5', session.directory || '—'),
      );
      card.appendChild(
        el(
          'p',
          'text-[11px] text-slate-600 dark:text-zinc-400 line-clamp-2 mt-1 min-h-[2.1em]',
          session.activity?.text ?? 'No activity yet',
        ),
      );

      const meta = el('div', 'flex items-center justify-between gap-2 mt-1.5 font-mono text-[10px] text-slate-600 dark:text-zinc-400');
      meta.appendChild(el('span', 'truncate', session.model?.label ?? 'model —'));
      meta.appendChild(el('span', 'shrink-0', `$${formatCost(session.cost)}`));
      card.appendChild(meta);

      const footer = el('div', 'flex items-center justify-between gap-2 mt-1 font-mono text-[10px] text-slate-500 dark:text-zinc-500');
      footer.appendChild(el('span', '', `${formatTokens(session.tokens)} tok · squad 8`));
      footer.appendChild(el('span', '', `updated ${timeAgo(session.updated)}`));
      card.appendChild(footer);

      card.addEventListener('click', () => sessionStore.select(session.id));
      grid.appendChild(card);
    });
  };

  const renderDossier = (): void => {
    const session = sessionStore.selected();
    const dName = $('dossierName');
    const dState = $('dossierState');
    const dTask = $('dossierTask');
    const dTool = $('dossierTool');
    const dLoad = $('dossierLoad');
    const dAvatar = $('dossierAvatar');

    if (!session) {
      if (dName) dName.textContent = 'No live session';
      if (dState) dState.textContent = 'OFFLINE';
      if (dTask) dTask.textContent = 'Start the bridge to stream real sessions';
      if (dTool) dTool.textContent = '—';
      if (dLoad) dLoad.textContent = '0';
      if (dAvatar) dAvatar.textContent = '–';
      return;
    }

    const ag = AGENTS[session.persona];
    const info = sourceInfo(session);
    if (dName) dName.textContent = `${ag.name} · ${session.title}`;
    if (dState) dState.textContent = session.status.toUpperCase();
    if (dTask) dTask.textContent = session.title;
    if (dTool) dTool.textContent = info ? `${session.model?.label ?? 'model —'} · ${info.label}` : session.model?.label ?? '—';
    if (dLoad) dLoad.textContent = formatTokens(session.tokens);
    if (dAvatar) {
      dAvatar.textContent = ag.name[0] ?? '?';
      dAvatar.style.borderColor = hexColor(ag.color);
    }
  };

  bus.on('sessions:update', render);
  bus.on('session:selected', () => {
    render();
    renderDossier();
  });
  bus.on('session:refresh', () => renderDossier());
  bus.on('session:focus', (payload) => {
    const session = sessionStore.sessions.find((s) => s.id === String(payload));
    if (session) bus.emit('selection:set', session.persona);
  });
  bus.on('selection:change', (payload) => {
    const persona = payload as AgentId;
    const session = sessionStore.byPersona(persona);
    if (session && session.id !== sessionStore.selectedId) sessionStore.select(session.id);
  });

  render();
  renderDossier();
}

/* ------------------------------------------------------------------- modal */
function initBridgeModal(): void {
  const modal = $('cliModal');
  const openBtn = $('bridgeBtn');
  const closeBtn = $('modalCloseBtn');
  const backdrop = $('cliModalBackdrop');
  const form = $<HTMLFormElement>('bridgeForm');
  const urlInput = $<HTMLInputElement>('wsInputUrl');
  const disconnectBtn = $('disconnectBridgeBtn');
  if (!modal || !openBtn || !closeBtn || !form || !urlInput) return;

  let lastFocus: Element | null = null;

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close();
  };

  const close = (): void => {
    modal.classList.add('hidden');
    document.removeEventListener('keydown', onKey);
    if (lastFocus instanceof HTMLElement) lastFocus.focus();
  };

  const open = (): void => {
    lastFocus = document.activeElement;
    modal.classList.remove('hidden');
    urlInput.value = appState.bridgeUrl || DEFAULT_BRIDGE_URL;
    urlInput.focus();
    document.addEventListener('keydown', onKey);
  };

  openBtn.addEventListener('click', open);
  closeBtn.addEventListener('click', close);
  backdrop?.addEventListener('click', close);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const url = urlInput.value.trim();
    if (!url) return;
    connectBridge(url);
    close();
  });

  disconnectBtn?.addEventListener('click', () => {
    disconnectBridge();
    close();
    bus.emit('toast', 'Disconnected from the bridge');
  });
}

/* ------------------------------------------------------------ view router */
export function initRouter(): void {
  const views: Record<ViewId, HTMLElement | null> = {
    office: $('view-office'),
    terminal: $('view-terminal'),
    activity: $('view-activity'),
  };

  const go = (view: ViewId): void => {
    appState.view = view;
    (Object.keys(views) as ViewId[]).forEach((k) => {
      const node = views[k];
      if (node) node.classList.toggle('hidden', k !== view);
    });
    document.querySelectorAll<HTMLElement>('[data-view]').forEach((link) => {
      const active = link.dataset['view'] === view;
      link.setAttribute('aria-current', active ? 'page' : 'false');
      link.classList.toggle('bg-slate-200', active);
      link.classList.toggle('dark:bg-zinc-700', active);
      link.classList.toggle('text-slate-900', active);
      link.classList.toggle('dark:text-white', active);
    });
    setSceneActive(view === 'office');
  };

  const sync = (): void => {
    const hash = window.location.hash.replace('#/', '');
    go(hash === 'terminal' || hash === 'activity' ? hash : 'office');
  };

  window.addEventListener('hashchange', sync);
  sync();
}

/* ------------------------------------------------------------ stage bar ui */

function worldBtnClass(active: boolean): string {
  return active
    ? 'px-2 py-0.5 rounded bg-slate-200 dark:bg-zinc-700 text-slate-900 dark:text-white font-medium hover:bg-slate-300 transition'
    : 'px-2 py-0.5 rounded text-slate-600 hover:text-slate-900 dark:text-zinc-400 dark:hover:text-white transition';
}

function initWorldSelector(): void {
  const box = $('worldSelector');
  if (!box) return;
  const refresh = (): void => {
    const current = getWorldThemeId();
    box.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
      const active = b.dataset['world'] === current;
      b.className = worldBtnClass(active);
      b.setAttribute('aria-pressed', String(active));
    });
  };
  WORLD_THEMES.forEach((theme) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset['world'] = theme.id;
    btn.title = theme.label;
    btn.textContent = `${theme.emoji} ${theme.label.split(' ')[0]}`;
    btn.addEventListener('click', () => {
      setWorldTheme(theme.id as WorldThemeId);
      refreshCameraButtons();
    });
    box.appendChild(btn);
  });
  refresh();
}

/** Pretty labels for world-specific camera presets. */
const PRESET_LABELS: Record<string, string> = {
  terrace: 'Terrace',
  balloon: 'Balloons',
  orchard: 'Orchard',
  arcade: 'Arcade',
  stage: 'Stage',
  drones: 'Drones',
  volley: 'Volley',
  tiki: 'Tiki Bar',
  pier: 'Pier',
  lighthouse: 'Lighthouse',
  train: 'Train',
  ballpit: 'Ball Pit',
  castle: 'Castle',
  wheel: 'Ferris Wheel',
  bay: 'Docking Bay',
  biodome: 'Biodome',
  rover: 'Rover',
  telescope: 'Telescope',
};

/** Show only the camera presets that exist in the active world. */
export function refreshCameraButtons(): void {
  const avail = new Set(availableCameraPresets());
  document.querySelectorAll<HTMLButtonElement>('[data-cam]').forEach((btn) => {
    const key = btn.dataset['cam'] ?? '';
    btn.hidden = !avail.has(key);
    if (avail.has(key) && !btn.title) btn.title = PRESET_LABELS[key] ?? key;
  });
  const anchor = document.querySelector('[data-cam="top"]');
  for (const key of avail) {
    if (document.querySelector(`[data-cam="${key}"]`)) continue;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset['cam'] = key;
    btn.className =
      'px-2 py-0.5 rounded text-slate-600 hover:text-slate-900 dark:text-zinc-400 dark:hover:text-white transition';
    btn.textContent = PRESET_LABELS[key] ?? key.toUpperCase();
    btn.addEventListener('click', () => setCameraPreset(key));
    anchor?.parentElement?.appendChild(btn);
  }
}

function initStageControls(): void {
  document.querySelectorAll<HTMLButtonElement>('[data-cam]').forEach((btn) => {
    btn.addEventListener('click', () => setCameraPreset(btn.dataset['cam'] ?? 'iso'));
  });
  refreshCameraButtons();
  initWorldSelector();
  $('coffeeBtn')?.addEventListener('click', () => coffeeBreak());
  const follow = $<HTMLInputElement>('followToggle');
  follow?.addEventListener('change', () => {
    appState.autoFollow = follow.checked;
  });
}

/* ------------------------------------------------------------------ boot */
export function initUi(): void {
  initHeader();
  initSpeechBubbles();
  initLogPanel();
  initThoughtPanel();
  initDiffPanel();
  initSessionTabs();
  initSessionPanel();
  initBridgeModal();
  initStageControls();
  initToasts();
}
