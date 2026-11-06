import { execFileAsync, MAX_OUTPUT_BYTES, sha256 } from './shared.js';

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
