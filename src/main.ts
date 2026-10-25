import './styles.css';

import { bus } from './store/store';
import { initScene } from './lib/scene';
import { autoConnectBridge } from './lib/bridge';
import { initOfficeTheme, initRouter, initUi } from './ui';

/* --------------------------------------------------------------------------
   Reveal the app only after the first frame is ready (no FOUC).
   -------------------------------------------------------------------------- */
function revealApp(): void {
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      document.documentElement.classList.add('app-ready');
      const splash = document.getElementById('bootSplash');
      window.setTimeout(() => splash?.remove(), 260);
    });
  });
}

/* --------------------------------------------------------------------------
   Boot — live-first: the dashboard streams real OpenCode sessions only.
   -------------------------------------------------------------------------- */
function boot(): void {
  initOfficeTheme();
  initUi();
  initRouter();

  const sceneOk = initScene();
  if (!sceneOk) {
    bus.emit('toast', '3D viewport unavailable — panels still live.');
  }

  autoConnectBridge();
  revealApp();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
