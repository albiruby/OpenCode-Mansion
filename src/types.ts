import type { Group as ThreeGroup } from 'three';

export type AgentId =
  | 'ada'
  | 'dylan'
  | 'quinn'
  | 'otto'
  | 'mia'
  | 'leo'
  | 'nova'
  | 'kai'
  | 'iris'
  | 'max';

export type LogType = 'THOUGHT' | 'TOOL' | 'BASH' | 'SUCCESS' | 'INFO' | 'USER' | 'ASSISTANT';

export const LOG_TYPES: readonly LogType[] = [
  'THOUGHT',
  'TOOL',
  'BASH',
  'SUCCESS',
  'INFO',
  'USER',
  'ASSISTANT',
];

export type AgentState =
  | 'PLANNING'
  | 'TYPING'
  | 'TESTING'
  | 'IDLE'
  | 'COFFEE'
  | 'WALKING'
  | 'TV';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface AgentDef {
  id: AgentId;
  name: string;
  role: string;
  badge: string;
  state: AgentState;
  defaultState: AgentState;
  pos3D: Vec3;
  /** Desk slot index in the office layout. */
  deskIndex: number;
  /** Ambient employees roam autonomously when they are not assigned to a session. */
  ambient: boolean;
  currentTask: string;
  defaultTask: string;
  file: string;
  tool: string;
  load: string;
  bubbleText: string;
  defaultBubble: string;
  color: number;
  hairColor: number;
  /** Runtime-only link to the built 3D character group (set by scene module). */
  meshGroup?: ThreeGroup;
}

/* ---------------------------------------------------------------- sessions */
export type SessionStatus = 'running' | 'idle' | 'failed';

/** Where a session comes from: the OpenCode service or a local transcript. */
export type SessionSource = 'opencode' | 'codex' | 'claude';

export interface SessionActivity {
  type: LogType;
  text: string;
  at: number;
}

export interface SessionModel {
  providerID: string;
  modelID: string;
  label: string;
}

export interface SessionSummary {
  id: string;
  source?: SessionSource;
  title: string;
  directory: string;
  persona: AgentId;
  agent?: string;
  model?: SessionModel;
  status: SessionStatus;
  outcome?: string;
  tokens: number;
  cost: number;
  created: number;
  updated: number;
  idle?: number;
  activity?: SessionActivity;
}

export interface SessionTotals {
  tokens: number;
  cost: number;
}

export interface RealFileDiff {
  file: string;
  patch: string;
  additions: number;
  deletions: number;
  status: 'added' | 'deleted' | 'modified';
}

export interface HistoryTool {
  name: string;
  status?: string;
  summary?: string;
}

export interface HistoryMessage {
  id: string;
  role: 'user' | 'assistant';
  at: number;
  text?: string;
  reasoning?: string;
  tools?: HistoryTool[];
}

/* ------------------------------------------------------------------- logs */
export interface LogEntry {
  id: number;
  /** Unix ms */
  time: number;
  agent: AgentId | 'system';
  type: LogType;
  tool?: string;
  message: string;
  sessionId?: string;
  sessionTitle?: string;
}

export type ViewId = 'office' | 'terminal' | 'activity';
