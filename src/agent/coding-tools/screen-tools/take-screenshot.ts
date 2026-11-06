import path from 'node:path';
import crypto from 'node:crypto';
import { execFileAsync, MAX_OUTPUT_BYTES } from '../common.js';
import { getScreenInfo } from './get-screen-info.js';
import { getCursorPositionLinux } from './cursor-helper.js';

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
