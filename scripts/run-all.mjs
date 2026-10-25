/**
 * One-command dev launch: OpenCode bridge + Vite dev server together.
 * Ctrl+C stops both. No extra dependencies.
 *
 *   npm start                # bridge on 4040, dashboard on http://localhost:5180
 *   npm start -- --url ...   # extra args after -- go to the bridge
 */
import { spawn } from 'node:child_process';
import process from 'node:process';

const passthrough = process.argv.slice(2);

const children = [];

function run(name, command, args, color) {
  const child = spawn(command, args, {
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  const pipe = (stream, out) => {
    stream.setEncoding('utf8');
    let pending = '';
    stream.on('data', (chunk) => {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) out(`${color}[${name}]${'\x1b[0m'} ${line}`);
    });
  };
  pipe(child.stdout, (line) => console.log(line));
  pipe(child.stderr, (line) => console.error(line));
  child.on('exit', (code) => {
    console.log(`${color}[${name}]${'\x1b[0m'} exited (${code ?? 'signal'})`);
    shutdown(code ?? 0);
  });
  children.push(child);
  return child;
}

function shutdown(code) {
  for (const child of children) {
    if (!child.killed) child.kill(process.platform === 'win32' ? undefined : 'SIGTERM');
  }
  process.exitCode = code ?? 0;
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

run('bridge', 'npx', ['tsx', 'server/bridge.ts', ...passthrough], '\x1b[36m');
run('vite', 'npx', ['vite'], '\x1b[35m');

console.log(
  '\x1b[32m OpenCode Virtual Office HQ \x1b[0m\n' +
    '  dashboard: http://localhost:5180  (needs a running OpenCode session app)\n' +
    '  bridge:    ws://127.0.0.1:4040  (auto-discovers your local OpenCode)\n',
);
