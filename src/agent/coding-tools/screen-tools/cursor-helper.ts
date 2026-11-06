import { execFileAsync } from '../common.js';

export async function getCursorPositionLinux(): Promise<{ x: number; y: number } | null> {
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
