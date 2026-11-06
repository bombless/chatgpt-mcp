import { execFileAsync, MAX_OUTPUT_BYTES } from '../common.js';
import { getScreenInfo } from './get-screen-info.js';

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
