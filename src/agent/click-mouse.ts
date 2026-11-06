import path from 'node:path';
import { execFileAsync, MAX_OUTPUT_BYTES } from './shared.js';
import { getScreenInfo } from './get-screen-info.js';
import { getCursorPositionLinux } from './get-cursor-position-linux.js';

export async function clickMouse(args: Record<string, unknown>) {
  const info = await getScreenInfo();
  const button = typeof args.button === 'string' && ['left', 'right', 'middle'].includes(args.button)
    ? args.button
    : 'left';
  const doubleClick = Boolean(args.doubleClick);
  const clickCount = doubleClick ? 2 : (Number.isInteger(Number(args.clickCount)) && Number(args.clickCount) > 0 ? Number(args.clickCount) : 1);

  let targetX: number | null = null;
  let targetY: number | null = null;

  const hasX = args.x !== undefined;
  const hasY = args.y !== undefined;
  if (hasX !== hasY) {
    throw new Error('Both x and y must be provided, or both omitted to click at current mouse position.');
  }

  if (args.screenIndex !== undefined) {
    const screenIndex = Number(args.screenIndex);
    const screen = info.screens.find(s => s.index === screenIndex);
    if (!screen) throw new Error(`No display found for screenIndex=${String(args.screenIndex)}`);
    if (hasX && hasY) {
      const x = Number(args.x);
      const y = Number(args.y);
      if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= screen.width || y >= screen.height) {
        throw new Error(`Coordinates x=${x}, y=${y} must be within display ${screen.index} bounds: x=0..${screen.width - 1}, y=0..${screen.height - 1}`);
      }
      targetX = screen.x + x;
      targetY = screen.y + y;
    }
  } else if (hasX && hasY) {
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
    const scriptPath = path.resolve(process.cwd(), 'scripts', 'click-mouse.ps1');
    const psArgs = [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-File', scriptPath,
      '-Button', button,
      '-ClickCount', String(clickCount),
    ];
    if (targetX !== null && targetY !== null) {
      psArgs.push('-X', String(targetX), '-Y', String(targetY));
    }
    const { stdout } = await execFileAsync('powershell.exe', psArgs, {
      windowsHide: true,
      timeout: 15000,
      maxBuffer: MAX_OUTPUT_BYTES,
    });
    const match = stdout.match(/^CLICK_RESULT:(\{.*?\})$/mu);
    if (!match) throw new Error(`PowerShell mouse click script failed: ${stdout.trim()}`);
    const result = JSON.parse(match[1]);
    finalX = Number(result.x);
    finalY = Number(result.y);
  } else if (process.platform === 'linux') {
    const buttonNum = button === 'right' ? '3' : button === 'middle' ? '2' : '1';
    if (targetX !== null && targetY !== null) {
      const xdotoolArgs = ['mousemove', String(targetX), String(targetY), 'click'];
      if (clickCount > 1) xdotoolArgs.push('--repeat', String(clickCount), '--delay', '60');
      xdotoolArgs.push(buttonNum);
      await execFileAsync('xdotool', xdotoolArgs, { timeout: 15000, maxBuffer: MAX_OUTPUT_BYTES });
      finalX = targetX;
      finalY = targetY;
    } else {
      const xdotoolArgs = ['click'];
      if (clickCount > 1) xdotoolArgs.push('--repeat', String(clickCount), '--delay', '60');
      xdotoolArgs.push(buttonNum);
      await execFileAsync('xdotool', xdotoolArgs, { timeout: 15000, maxBuffer: MAX_OUTPUT_BYTES });
      const cur = await getCursorPositionLinux();
      finalX = cur?.x ?? 0;
      finalY = cur?.y ?? 0;
    }
  } else {
    throw new Error('Mouse clicking is supported on Windows and Linux/X11 only.');
  }

  const activeScreen = info.screens.find(s =>
    finalX >= s.x && finalX < s.x + s.width &&
    finalY >= s.y && finalY < s.y + s.height
  ) ?? null;

  return {
    ok: true,
    button,
    clickCount,
    x: finalX,
    y: finalY,
    screenIndex: activeScreen ? activeScreen.index : null,
    relativeX: activeScreen ? finalX - activeScreen.x : null,
    relativeY: activeScreen ? finalY - activeScreen.y : null,
  };
}
