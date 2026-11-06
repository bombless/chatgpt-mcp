import path from 'node:path';
import { execFileAsync, MAX_OUTPUT_BYTES } from './shared.js';
import { getScreenInfo } from './get-screen-info.js';

export async function moveMouse(args: Record<string, unknown>) {
  const info = await getScreenInfo();

  const hasX = args.x !== undefined;
  const hasY = args.y !== undefined;
  if (!hasX || !hasY) {
    throw new Error('Both x and y must be provided to move the mouse cursor.');
  }

  let targetX: number;
  let targetY: number;

  if (args.screenIndex !== undefined) {
    const screenIndex = Number(args.screenIndex);
    const screen = info.screens.find(s => s.index === screenIndex);
    if (!screen) throw new Error(`No display found for screenIndex=${String(args.screenIndex)}`);
    const x = Number(args.x);
    const y = Number(args.y);
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= screen.width || y >= screen.height) {
      throw new Error(`Coordinates x=${x}, y=${y} must be within display ${screen.index} bounds: x=0..${screen.width - 1}, y=0..${screen.height - 1}`);
    }
    targetX = screen.x + x;
    targetY = screen.y + y;
  } else {
    const x = Number(args.x);
    const y = Number(args.y);
    if (!Number.isInteger(x) || !Number.isInteger(y)) {
      throw new Error('x and y coordinates must be integers.');
    }
    targetX = x;
    targetY = y;
  }

  let finalX: number;
  let finalY: number;

  if (process.platform === 'win32') {
    const scriptPath = path.resolve(process.cwd(), 'scripts', 'move-mouse.ps1');
    const psArgs = [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-File', scriptPath,
      '-X', String(targetX),
      '-Y', String(targetY),
    ];
    const { stdout } = await execFileAsync('powershell.exe', psArgs, {
      windowsHide: true,
      timeout: 15000,
      maxBuffer: MAX_OUTPUT_BYTES,
    });
    const match = stdout.match(/^MOVE_RESULT:(\{.*?\})$/mu);
    if (!match) throw new Error(`PowerShell mouse move script failed: ${stdout.trim()}`);
    const result = JSON.parse(match[1]);
    finalX = Number(result.x);
    finalY = Number(result.y);
  } else if (process.platform === 'linux') {
    await execFileAsync('xdotool', ['mousemove', String(targetX), String(targetY)], { timeout: 15000, maxBuffer: MAX_OUTPUT_BYTES });
    finalX = targetX;
    finalY = targetY;
  } else {
    throw new Error('Mouse moving is supported on Windows and Linux/X11 only.');
  }

  const activeScreen = info.screens.find(s =>
    finalX >= s.x && finalX < s.x + s.width &&
    finalY >= s.y && finalY < s.y + s.height
  ) ?? null;

  return {
    ok: true,
    x: finalX,
    y: finalY,
    screenIndex: activeScreen ? activeScreen.index : null,
    relativeX: activeScreen ? finalX - activeScreen.x : null,
    relativeY: activeScreen ? finalY - activeScreen.y : null,
  };
}
