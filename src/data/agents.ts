import type { AgentDef, AgentId } from '../types';

/** Desk grid: 5 columns × 2 rows. Characters stand in front of each desk. */
const DESK_X = [-17, -11, -5, 1, 7];
const ROW_Z = [-6, -1];

function deskPos(index: number): { x: number; z: number } {
  const row = Math.floor(index / 5);
  const col = index % 5;
  return { x: DESK_X[col] ?? 0, z: (ROW_Z[row] ?? row) + 0.95 };
}

const IDLE_TASK = 'Waiting for a live session';

function makeAgent(
  base: Omit<AgentDef, 'pos3D' | 'deskIndex' | 'ambient' | 'defaultState' | 'defaultTask' | 'defaultBubble' | 'currentTask' | 'state' | 'file' | 'tool' | 'load' | 'bubbleText'>,
  deskIndex: number,
  ambient: boolean,
): AgentDef {
  const pos = deskPos(deskIndex);
  return {
    ...base,
    state: 'IDLE',
    defaultState: 'IDLE',
    currentTask: IDLE_TASK,
    defaultTask: IDLE_TASK,
    file: '',
    tool: '—',
    load: '—',
    bubbleText: '',
    defaultBubble: '',
    deskIndex,
    ambient,
    pos3D: { x: pos.x, y: 0, z: pos.z },
  };
}

export const AGENTS: Record<AgentId, AgentDef> = {
  ada: makeAgent(
    {
      id: 'ada',
      name: 'Ada',
      role: 'Architect / Planner',
      badge: 'Spec Planner',
      color: 0x4f46e5,
      hairColor: 0x312e81,
    },
    0,
    false,
  ),
  leo: makeAgent(
    {
      id: 'leo',
      name: 'Leo',
      role: 'Data Engineer',
      badge: 'Pipelines',
      color: 0x2563eb,
      hairColor: 0x1e3a8a,
    },
    1,
    true,
  ),
  mia: makeAgent(
    {
      id: 'mia',
      name: 'Mia',
      role: 'Product Designer',
      badge: 'Design Systems',
      color: 0xc026d3,
      hairColor: 0x701a75,
    },
    2,
    true,
  ),
  dylan: makeAgent(
    {
      id: 'dylan',
      name: 'Dylan',
      role: 'Core Engineer / Coder',
      badge: 'Lead Coder',
      color: 0x0284c7,
      hairColor: 0x0f172a,
    },
    3,
    false,
  ),
  nova: makeAgent(
    {
      id: 'nova',
      name: 'Nova',
      role: 'Researcher',
      badge: 'Docs & RFCs',
      color: 0x7c3aed,
      hairColor: 0x4c1d95,
    },
    4,
    true,
  ),
  quinn: makeAgent(
    {
      id: 'quinn',
      name: 'Quinn',
      role: 'QA & Test Reviewer',
      badge: 'Test Reviewer',
      color: 0x059669,
      hairColor: 0x14532d,
    },
    5,
    false,
  ),
  kai: makeAgent(
    {
      id: 'kai',
      name: 'Kai',
      role: 'Frontend Engineer',
      badge: 'UI Engineering',
      color: 0x0d9488,
      hairColor: 0x134e4a,
    },
    6,
    true,
  ),
  iris: makeAgent(
    {
      id: 'iris',
      name: 'Iris',
      role: 'Site Reliability Engineer',
      badge: 'Reliability',
      color: 0xe11d48,
      hairColor: 0x881337,
    },
    7,
    true,
  ),
  otto: makeAgent(
    {
      id: 'otto',
      name: 'Otto',
      role: 'DevOps & Git Scribe',
      badge: 'DevOps & Commits',
      color: 0xd97706,
      hairColor: 0x78350f,
    },
    8,
    false,
  ),
  max: makeAgent(
    {
      id: 'max',
      name: 'Max',
      role: 'Intern',
      badge: 'Learning Ops',
      color: 0x65a30d,
      hairColor: 0x3f6212,
    },
    9,
    true,
  ),
};

export const AGENT_IDS: AgentId[] = ['ada', 'leo', 'mia', 'dylan', 'nova', 'quinn', 'kai', 'iris', 'otto', 'max'];
