import path from 'node:path';
import { execFileAsync, MAX_OUTPUT_BYTES } from './shared.js';
import { getScreenInfo } from './get-screen-info.js';
import { getCursorPositionLinux } from './get-cursor-position-linux.js';

export async function scrollMouse(args: Record<string, unknown>) {
  const info = await getScreenInfo();

  let direction = typeof args.direction === 'string' && ['up', 'down', 'left', 'right'].includes(args.direction.toLowerCase())
    ? (args.direction.toLowerCase() as 'up' | 'down' | 'left' | 'right')
    : 'down';
  let amount = Number.isInteger(Number(args.amount)) && Number(args.amount) > 0
    ? Number(args.amount)
    : 1;

  if (args.deltaY !== undefined) {
    const dy = Number(args.deltaY);
    if (!Number.isInteger(dy)) {
      throw new Error('deltaY must be an integer.');
    }
    if (dy < 0) {
      direction = 'up';
      amount = Math.abs(dy);
    } else if (dy > 0) {
      direction = 'down';
      amount = dy;
    }
  } else if (args.deltaX !== undefined) {
    const dx = Number(args.deltaX);
    if (!Number.isInteger(dx)) {
      throw new Error('deltaX must be an integer.');
    }
    if (dx < 0) {
      direction = 'left';
      amount = Math.abs(dx);
    } else if (dx > 0) {
      direction = 'right';
      amount = dx;
    }
  }

  let targetX: number | null = null;
  let targetY: number | null = null;

  const hasX = args.x !== undefined;
  const hasY = args.y !== undefined;
  if (hasX !== hasY) {
    throw new Error('Both x and y must be provided, or both omitted to scroll at current mouse position.');
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
    const scriptPath = path.resolve(process.cwd(), 'scripts', 'scroll-mouse.ps1');
    const psArgs = [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-File', scriptPath,
      '-Direction', direction,
      '-Amount', String(amount),
    ];
    if (targetX !== null && targetY !== null) {
      psArgs.push('-X', String(targetX), '-Y', String(targetY));
    }
    const { stdout } = await execFileAsync('powershell.exe', psArgs, {
      windowsHide: true,
      timeout: 15000,
      maxBuffer: MAX_OUTPUT_BYTES,
    });
    const match = stdout.match(/^SCROLL_RESULT:(\{.*?\})$/mu);
    if (!match) throw new Error(`PowerShell mouse scroll script failed: ${stdout.trim()}`);
    const result = JSON.parse(match[1]);
    finalX = Number(result.x);
    finalY = Number(result.y);
  } else if (process.platform === 'linux') {
    const buttonNum = direction === 'up' ? '4' : direction === 'down' ? '5' : direction === 'left' ? '6' : '7';
    if (targetX !== null && targetY !== null) {
      const xdotoolArgs = ['mousemove', String(targetX), String(targetY), 'click'];
      if (amount > 1) xdotoolArgs.push('--repeat', String(amount), '--delay', '20');
      xdotoolArgs.push(buttonNum);
      await execFileAsync('xdotool', xdotoolArgs, { timeout: 15000, maxBuffer: MAX_OUTPUT_BYTES });
      finalX = targetX;
      finalY = targetY;
    } else {
      const xdotoolArgs = ['click'];
      if (amount > 1) xdotoolArgs.push('--repeat', String(amount), '--delay', '20');
      xdotoolArgs.push(buttonNum);
      await execFileAsync('xdotool', xdotoolArgs, { timeout: 15000, maxBuffer: MAX_OUTPUT_BYTES });
      const cur = await getCursorPositionLinux();
      finalX = cur?.x ?? 0;
      finalY = cur?.y ?? 0;
    }
  } else {
    throw new Error('Mouse scrolling is supported on Windows and Linux/X11 only.');
  }

  const activeScreen = info.screens.find(s =>
    finalX >= s.x && finalX < s.x + s.width &&
    finalY >= s.y && finalY < s.y + s.height
  ) ?? null;

  return {
    ok: true,
    direction,
    amount,
    x: finalX,
    y: finalY,
    screenIndex: activeScreen ? activeScreen.index : null,
    relativeX: activeScreen ? finalX - activeScreen.x : null,
    relativeY: activeScreen ? finalY - activeScreen.y : null,
  };
}
