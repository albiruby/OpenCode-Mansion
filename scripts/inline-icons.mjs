/**
 * Build-time helper: replace <span data-lucide="…"></span> placeholders in
 * index.html with inline SVG markup (no runtime icon loader → no icon flash).
 *
 * Usage: node scripts/inline-icons.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import {
  Activity,
  Box,
  ChevronRight,
  Clock,
  Coffee,
  Cpu,
  Moon,
  Radio,
  Send,
  Sun,
  Terminal,
  Trash2,
  Volume2,
  VolumeX,
  X,
} from 'lucide';

const ICONS = {
  activity: Activity,
  box: Box,
  'chevron-right': ChevronRight,
  clock: Clock,
  coffee: Coffee,
  cpu: Cpu,
  moon: Moon,
  radio: Radio,
  send: Send,
  sun: Sun,
  terminal: Terminal,
  'trash-2': Trash2,
  'volume-2': Volume2,
  'volume-x': VolumeX,
  x: X,
};

const file = new URL('../index.html', import.meta.url);
let html = readFileSync(file, 'utf8');
let replaced = 0;
let missed = 0;

html = html.replace(/<span\b([^>]*\bdata-lucide="([^"]+)"[^>]*)><\/span>/g, (match, attrs, name) => {
  const nodes = ICONS[name];
  if (!nodes) {
    missed += 1;
    console.warn(`[icons] unknown icon: ${name}`);
    return match;
  }
  const classMatch = attrs.match(/\bclass="([^"]*)"/);
  const idMatch = attrs.match(/\bid="([^"]*)"/);
  const className = classMatch ? classMatch[1] : '';
  const id = idMatch ? ` id="${idMatch[1]}"` : '';
  const children = nodes
    .map(([tag, nodeAttrs]) => {
      const rendered = Object.entries(nodeAttrs)
        .map(([k, v]) => `${k}="${String(v)}"`)
        .join(' ');
      return `<${tag} ${rendered}/>`;
    })
    .join('');
  replaced += 1;
  return `<svg${id} class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${children}</svg>`;
});

writeFileSync(file, html);
console.log(`[icons] inlined ${replaced} icon(s), ${missed} unknown`);
