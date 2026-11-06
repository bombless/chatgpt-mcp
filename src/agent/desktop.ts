import path from 'node:path';
import crypto from 'node:crypto';
import { execFileAsync, MAX_OUTPUT_BYTES, sha256 } from './shared.js';
export async function getScreenInfo() {
  if (process.platform === 'win32') {
    const script = "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class DpiAwareness { [DllImport(\"shcore.dll\")] public static extern int SetProcessDpiAwareness(int awareness); }'; try { [void][DpiAwareness]::SetProcessDpiAwareness(2) } catch {}; Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::AllScreens | ForEach-Object { $b=$_.Bounds; [PSCustomObject]@{ deviceName=$_.DeviceName; x=$b.X; y=$b.Y; width=$b.Width; height=$b.Height; primary=$_.Primary } } | ConvertTo-Json -Compress";
    const { stdout } = await execFileAsync('powershell.exe', ['-NoLogo','-NoProfile','-NonInteractive','-Command', script], { windowsHide: true, timeout: 15000, maxBuffer: MAX_OUTPUT_BYTES });
    const parsed = JSON.parse(stdout.trim() || '[]');
    const screens = (Array.isArray(parsed) ? parsed : [parsed]).map((s: any, index: number) => ({ index, deviceName: String(s.deviceName), x: Number(s.x), y: Number(s.y), width: Number(s.width), height: Number(s.height), primary: Boolean(s.primary) }));
    return { platform: process.platform, screens };
  }
  if (process.platform === 'linux') {
    const { stdout } = await execFileAsync('xrandr', ['--listmonitors'], { timeout: 10000, maxBuffer: MAX_OUTPUT_BYTES });
    const screens = stdout.split(/\r?\n/u).slice(1).filter(Boolean).map((line, index) => {
      const m = line.match(/(\d+)\/\d+x(\d+)\/\d+\+(-?\d+)\+(-?\d+)/u);
      if (!m) return null;
      return { index, deviceName: line.trim().split(/\s+/u).slice(1).join(' ').replace(/^\+?\*?/u, ''), x: Number(m[3]), y: Number(m[4]), width: Number(m[1]), height: Number(m[2]), primary: line.includes('*') };
    }).filter((s): s is NonNullable<typeof s> => s !== null);
    return { platform: process.platform, screens };
  }
  throw new Error('Screen capture is supported on Windows and Linux/X11 only.');
}

export async function getScreenPixel(args: Record<string, unknown>) {
  const info = await getScreenInfo();
  const screenIndex = Number(args.screenIndex);
  const screen = info.screens.find(s => s.index === screenIndex);
  if (!screen) throw new Error(`No display found for screenIndex=${String(args.screenIndex)}`);
  const x = Number(args.x);
  const y = Number(args.y);
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= screen.width || y >= screen.height) {
    throw new Error(`Pixel coordinates must be integers within display ${screen.index} bounds: x=0..${screen.width - 1}, y=0..${screen.height - 1}`);
  }
  const absoluteX = screen.x + x;
  const absoluteY = screen.y + y;
  let rgb: { r: number; g: number; b: number };
  if (process.platform === 'win32') {
    const script = "Add-Type -AssemblyName System.Drawing; $bmp = New-Object System.Drawing.Bitmap(1,1); $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen(" + absoluteX + "," + absoluteY + ",0,0,[System.Drawing.Size]::new(1,1)); $c = $bmp.GetPixel(0,0); [PSCustomObject]@{r=$c.R;g=$c.G;b=$c.B} | ConvertTo-Json -Compress; $g.Dispose(); $bmp.Dispose()";
    const { stdout } = await execFileAsync('powershell.exe', ['-NoLogo','-NoProfile','-NonInteractive','-Command', script], { windowsHide: true, timeout: 15000, maxBuffer: MAX_OUTPUT_BYTES });
    const pixel = JSON.parse(stdout.trim());
    rgb = { r: Number(pixel.r), g: Number(pixel.g), b: Number(pixel.b) };
  } else if (process.platform === 'linux') {
    const minX = Math.min(...info.screens.map(s => s.x));
    const minY = Math.min(...info.screens.map(s => s.y));
    const { stdout } = await execFileAsync('import', ['-window','root','-crop',`1x1+${absoluteX - minX}+${absoluteY - minY}`,'+repage','txt:-'], { encoding: 'utf8', timeout: 15000, maxBuffer: MAX_OUTPUT_BYTES });
    const match = stdout.match(/#([0-9A-Fa-f]{6})/u);
    if (!match) throw new Error(`Unable to parse pixel color from ImageMagick: ${stdout.trim().slice(0, 200)}`);
    const hex = match[1];
    rgb = { r: parseInt(hex.slice(0,2),16), g: parseInt(hex.slice(2,4),16), b: parseInt(hex.slice(4,6),16) };
  } else {
    throw new Error('Screen pixel probing is supported on Windows and Linux/X11 only.');
  }
  const hex = '#' + [rgb.r, rgb.g, rgb.b].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();
  return { screenIndex: screen.index, deviceName: screen.deviceName, x, y, absoluteX, absoluteY, ...rgb, hex, format: 'RGB 8-bit/channel', note: 'Coordinates x/y are relative to the selected display; absoluteX/absoluteY are virtual-desktop coordinates.' };
}

async function getCursorPositionLinux(): Promise<{ x: number; y: number } | null> {
  try {
    const { stdout } = await execFileAsync('xdotool', ['getmouselocation', '--shell'], { timeout: 5000 });
    const matchX = stdout.match(/^X=(\d+)/mu);
    const matchY = stdout.match(/^Y=(\d+)/mu);
    if (matchX && matchY) {
      return { x: Number(matchX[1]), y: Number(matchY[1]) };
    }
  } catch {
    // xdotool not available
  }
  return null;
}

export async function takeScreenshot(args: Record<string, unknown>) {
  const info = await getScreenInfo();
  const highlightCursor = Boolean(args.highlightCursor ?? args.highlightMouse);
  const hasCrop = ['x', 'y', 'width', 'height'].some(key => args[key] !== undefined);
  if (hasCrop && (args.screenIndex === undefined || !['x', 'y', 'width', 'height'].every(key => args[key] !== undefined))) {
    throw new Error('A cropped screenshot requires screenIndex plus all four values: x, y, width, height (x/y are zero-based display-relative coordinates).');
  }
  const wanted = args.screenIndex === undefined ? info.screens : info.screens.filter(s => s.index === Number(args.screenIndex));
  if (!wanted.length) throw new Error(`No display found for screenIndex=${String(args.screenIndex)}`);
  if (hasCrop && wanted.length !== 1) throw new Error('A cropped screenshot must target exactly one display.');
  let globalCursor: { x: number; y: number } | null = null;
  const screens = [];
  for (const screen of wanted) {
    const cropX = hasCrop ? Number(args.x) : 0;
    const cropY = hasCrop ? Number(args.y) : 0;
    const captureWidth = hasCrop ? Number(args.width) : screen.width;
    const captureHeight = hasCrop ? Number(args.height) : screen.height;
    if (![cropX, cropY, captureWidth, captureHeight].every(Number.isInteger) || cropX < 0 || cropY < 0 || captureWidth < 1 || captureHeight < 1 || cropX + captureWidth > screen.width || cropY + captureHeight > screen.height) {
      throw new Error(`Screenshot crop is outside display ${screen.index}; display size is ${screen.width}x${screen.height}.`);
    }
    const captureX = screen.x + cropX;
    const captureY = screen.y + cropY;
    let data: string;
    const mimeType = 'image/jpeg';
    if (process.platform === 'win32') {
      const scriptPath = path.resolve(process.cwd(), 'scripts', 'screen-capture.ps1');
      const psArgs = [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-File', scriptPath,
        '-X', String(captureX), '-Y', String(captureY),
        '-CaptureWidth', String(captureWidth), '-CaptureHeight', String(captureHeight),
      ];
      if (highlightCursor) {
        psArgs.push('-HighlightCursor');
      }
      const { stdout } = await execFileAsync('powershell.exe', psArgs, { windowsHide: true, timeout: 30000, maxBuffer: Math.max(MAX_OUTPUT_BYTES, 100_000_000) });
      const match = stdout.match(/^SCREENSHOT_BASE64:([A-Za-z0-9+/]+={0,2})$/mu);
      if (!match) throw new Error('PowerShell screenshot script did not return a valid Base64 payload');
      data = match[1];

      const cursorMatch = stdout.match(/^SCREENSHOT_CURSOR:(\{"x":-?\d+,"y":-?\d+\})$/mu);
      if (cursorMatch && !globalCursor) {
        try {
          globalCursor = JSON.parse(cursorMatch[1]);
        } catch {
          // ignore
        }
      }
    } else if (process.platform === 'linux') {
      if (!globalCursor) {
        globalCursor = await getCursorPositionLinux();
      }
      const minX = Math.min(...info.screens.map(s => s.x));
      const minY = Math.min(...info.screens.map(s => s.y));
      const { stdout } = await execFileAsync('import', ['-window', 'root', '-crop', `${captureWidth}x${captureHeight}+${captureX - minX}+${captureY - minY}`, '+repage', '-resize', '1000x1000>', '-quality', '82', 'jpeg:-'], { encoding: 'buffer', timeout: 30000, maxBuffer: Math.max(MAX_OUTPUT_BYTES, 20_000_000) }) as any;
      data = Buffer.from(stdout).toString('base64');
    } else throw new Error('Screen capture is supported on Windows and Linux/X11 only.');
    if (!data || !/^[A-Za-z0-9+/]+={0,2}$/u.test(data)) throw new Error(`Screenshot capture returned invalid JPEG base64 for display ${screen.index}`);
    const imageBytes = Buffer.from(data, 'base64');
    if (imageBytes.length < 4 || imageBytes[0] !== 0xff || imageBytes[1] !== 0xd8 || imageBytes[imageBytes.length - 2] !== 0xff || imageBytes[imageBytes.length - 1] !== 0xd9) throw new Error(`Screenshot JPEG integrity check failed for display ${screen.index}; base64Chars=${data.length}, bytes=${imageBytes.length}`);
    const scale = Math.min(1, 1000 / captureWidth, 1000 / captureHeight);
    const outputWidth = Math.max(1, Math.round(captureWidth * scale));
    const outputHeight = Math.max(1, Math.round(captureHeight * scale));
    const dataSha256 = crypto.createHash('sha256').update(imageBytes).digest('hex');
    console.log(`[agent][screenshot] captured display=${screen.index} region=${cropX},${cropY},${captureWidth}x${captureHeight} output=${outputWidth}x${outputHeight} bytes=${imageBytes.length} sha256=${dataSha256}`);
    screens.push({ ...screen, x: captureX, y: captureY, width: outputWidth, height: outputHeight, captureX: cropX, captureY: cropY, captureWidth, captureHeight, mimeType, data, dataBytes: imageBytes.length, dataSha256 });
  }

  let cursorInfo: { x: number; y: number; screenIndex: number | null; relativeX: number | null; relativeY: number | null } | null = null;
  if (globalCursor) {
    const activeScreen = info.screens.find(s =>
      globalCursor!.x >= s.x &&
      globalCursor!.x < s.x + s.width &&
      globalCursor!.y >= s.y &&
      globalCursor!.y < s.y + s.height
    ) ?? null;

    cursorInfo = {
      x: globalCursor.x,
      y: globalCursor.y,
      screenIndex: activeScreen ? activeScreen.index : null,
      relativeX: activeScreen ? globalCursor.x - activeScreen.x : null,
      relativeY: activeScreen ? globalCursor.y - activeScreen.y : null,
    };
  }

  return { cursor: cursorInfo, screens };
}

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

export async function takeAdbScreenshot(args: Record<string, unknown>) {
  const requestedSerial = typeof args.serial === 'string' && args.serial.trim() ? args.serial.trim() : undefined;
  const { stdout: deviceOutput } = await execFileAsync('adb', ['devices'], {
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  const devices = deviceOutput.split(/\r?\n/u).slice(1)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const [serial, state] = line.split(/\s+/u);
      return { serial, state };
    });
  const online = devices.filter(device => device.state === 'device');
  let serial = requestedSerial;
  if (serial) {
    if (!online.some(device => device.serial === serial)) {
      const state = devices.find(device => device.serial === serial)?.state;
      throw new Error(state
        ? `ADB device '${serial}' is not ready (state: ${state}). Check the phone's USB debugging authorization/connection.`
        : `ADB device '${serial}' was not found. Run 'adb devices' to inspect connected devices.`);
    }
  } else if (online.length === 1) {
    serial = online[0].serial;
  } else if (online.length === 0) {
    throw new Error('No authorized Android device found. Connect a phone, enable USB debugging, and confirm it appears as device in adb devices.');
  } else {
    throw new Error(`Multiple Android devices are connected (${online.map(device => device.serial).join(', ')}). Specify serial to choose one.`);
  }

  const { stdout } = await execFileAsync('adb', ['-s', serial!, 'exec-out', 'screencap', '-p'], {
    encoding: 'buffer',
    timeout: 20000,
    maxBuffer: 20 * 1024 * 1024,
  });
  const bytes = Buffer.from(stdout as unknown as Buffer);
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(pngSignature)) {
    throw new Error('ADB returned invalid screenshot data; expected a PNG from screencap.');
  }
  if (bytes.length > 20 * 1024 * 1024) throw new Error(`Screenshot exceeds the 20 MiB size limit: ${bytes.length} bytes`);
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width < 1 || height < 1) throw new Error('ADB returned a PNG with invalid dimensions.');
  return {
    serial,
    mimeType: 'image/png',
    width,
    height,
    data: bytes.toString('base64'),
    dataBytes: bytes.length,
    dataSha256: sha256(bytes),
  };
}
