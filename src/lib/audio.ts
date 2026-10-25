/**
 * Web Audio synth for soft interaction feedback.
 * AudioContext is only created after a user gesture (autoplay policy safe).
 */

let ctx: AudioContext | null = null;
let enabled = true;

export function ensureAudio(): void {
  if (!ctx) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    try {
      ctx = new AC();
    } catch {
      ctx = null;
    }
  }
  if (ctx && ctx.state === 'suspended') void ctx.resume();
}

export function isAudioEnabled(): boolean {
  return enabled;
}

export function setAudioEnabled(next: boolean): void {
  enabled = next;
  if (enabled) ensureAudio();
}

export function playTypewriterTick(): void {
  if (!enabled || !ctx) return;
  try {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(360 + Math.random() * 240, ctx.currentTime);
    gain.gain.setValueAtTime(0.015, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.04);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.04);
  } catch {
    /* non-fatal */
  }
}

export function playSoftChime(isPositive = true): void {
  if (!enabled || !ctx) return;
  try {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(isPositive ? 659.25 : 329.63, ctx.currentTime);
    gain.gain.setValueAtTime(0.03, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.28);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.28);
  } catch {
    /* non-fatal */
  }
}
