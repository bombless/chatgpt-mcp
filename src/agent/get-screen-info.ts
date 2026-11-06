import { execFileAsync, MAX_OUTPUT_BYTES } from './shared.js';

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
