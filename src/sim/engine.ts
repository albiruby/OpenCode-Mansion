import { AGENT_IDS, AGENTS } from '../data/agents';
import { bus } from '../store/store';

/** Purely visual office break — no fake telemetry is generated. */
export function coffeeBreak(): void {
  const snapshot = AGENT_IDS.map((id) => ({
    id,
    state: AGENTS[id].state,
    bubble: AGENTS[id].bubbleText,
  }));

  AGENT_IDS.forEach((id) => {
    AGENTS[id].state = 'COFFEE';
    AGENTS[id].bubbleText = '☕ Coffee break';
    bus.emit('agent:update', id);
  });
  bus.emit('toast', 'Office coffee run');

  window.setTimeout(() => {
    snapshot.forEach((entry) => {
      AGENTS[entry.id].state = entry.state;
      AGENTS[entry.id].bubbleText = entry.bubble;
      bus.emit('agent:update', entry.id);
    });
  }, 5000);
}
