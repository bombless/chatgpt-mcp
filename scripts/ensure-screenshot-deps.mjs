import { spawnSync } from 'node:child_process';
import process from 'node:process';

const isWindows = process.platform === 'win32';
const candidates = isWindows
  ? [{ command: 'python.exe', prefix: [] }, { command: 'py.exe', prefix: ['-3'] }]
  : [{ command: 'python3', prefix: [] }, { command: 'python', prefix: [] }];

function run(command, args) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120_000,
    env: process.env,
  });
}

function works(candidate) {
  const result = run(candidate.command, [
    ...candidate.prefix,
    '-c',
    "from PIL import Image, ImageGrab; print('Pillow screenshot support OK')",
  ]);
  return result.status === 0;
}

let python = candidates.find(works);

if (!python) {
  python = candidates.find((candidate) => {
    const result = run(candidate.command, [...candidate.prefix, '--version']);
    return result.status === 0;
  });
}

if (!python) {
  console.error('[agent] Screenshot prerequisite missing: Python 3 was not found.');
  console.error(isWindows
    ? 'Install Python 3 from https://www.python.org/downloads/windows/ and enable "Add python.exe to PATH", then rerun npm run agent.'
    : 'Install Python 3 using your operating system package manager, then rerun npm run agent.');
  process.exit(1);
}

if (!works(python)) {
  console.log('[agent] Pillow screenshot support is missing; attempting to install Pillow...');
  let install = run(python.command, [...python.prefix, '-m', 'pip', 'install', '--user', 'Pillow']);
  if (install.status !== 0) {
    console.warn('[agent] User-level pip install failed; trying pip install Pillow...');
    install = run(python.command, [...python.prefix, '-m', 'pip', 'install', 'Pillow']);
  }

  if (install.stdout) process.stdout.write(install.stdout);
  if (install.stderr) process.stderr.write(install.stderr);

  if (install.status !== 0 || !works(python)) {
    console.error('[agent] Could not install/verify Pillow screenshot support.');
    console.error('Check network access and Python pip permissions, install Pillow manually with:');
    console.error(`  ${python.command} ${[...python.prefix, '-m', 'pip', 'install', '--user', 'Pillow'].join(' ')}`);
    process.exit(1);
  }
}

console.log('[agent] Screenshot prerequisite check passed: Python and Pillow ImageGrab are available.');
