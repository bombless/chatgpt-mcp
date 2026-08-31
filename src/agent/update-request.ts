import net from 'node:net';

const pipeName = process.env.MCP_UPDATE_PIPE ?? 'mcp-update-agent';
const pipePath = `\\\\.\\pipe\\${pipeName}`;

export function requestAgentUpdate() {
  return new Promise<void>((resolve, reject) => {
    const socket = net.createConnection(pipePath);
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error); else resolve();
    };
    socket.setTimeout(5_000, () => finish(new Error('mcp-update named pipe timeout')));
    socket.once('error', error => finish(error));
    socket.once('connect', () => {
      socket.end(JSON.stringify({ type: 'update' }) + '\n', () => finish());
    });
  });
}
