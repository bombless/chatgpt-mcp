import net from 'node:net';
import crypto from 'node:crypto';

const UPDATE_WEBHOOK_TOKEN = process.env.UPDATE_WEBHOOK_TOKEN;
const UPDATE_SOCKET = process.env.UPDATE_SOCKET ?? '/run/mcp-update.sock';
const UPDATE_REPO = 'bombless/chatgpt-mcp';
const UPDATE_BRANCH = process.env.UPDATE_BRANCH ?? 'main';

export type UpdateRequest = {
  repository?: unknown;
  ref?: unknown;
  sha?: unknown;
};

function timingSafeTokenEqual(actual: string | undefined, expected: string | undefined) {
  if (!actual || !expected) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function fetchGithubMainSha() {
  const response = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/commits/${encodeURIComponent(UPDATE_BRANCH)}`, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'chatgpt-mcp-update-checker',
    },
  });
  if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
  const data = await response.json() as { sha?: string };
  if (!data.sha || !/^[0-9a-f]{40}$/i.test(data.sha)) throw new Error('GitHub response did not contain a valid commit SHA');
  return data.sha.toLowerCase();
}

function notifyUpdater(expectedSha: string) {
  return new Promise<void>((resolve, reject) => {
    const socket = net.createConnection(UPDATE_SOCKET);
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error); else resolve();
    };
    socket.setTimeout(5_000, () => finish(new Error('mcp-update socket timeout')));
    socket.once('error', error => finish(error));
    socket.once('connect', () => {
      socket.end(JSON.stringify({ type: 'update', repository: UPDATE_REPO, branch: UPDATE_BRANCH, sha: expectedSha }) + '\n', () => finish());
    });
  });
}

export async function requestUpdate(body: UpdateRequest) {
  if (!UPDATE_WEBHOOK_TOKEN) throw new Error('UPDATE_WEBHOOK_TOKEN is not configured');
  if (body.repository !== UPDATE_REPO) throw new Error('invalid repository');
  if (body.ref !== `refs/heads/${UPDATE_BRANCH}`) throw new Error('invalid ref');
  if (typeof body.sha !== 'string' || !/^[0-9a-f]{40}$/i.test(body.sha)) throw new Error('invalid sha');

  const expectedSha = body.sha.toLowerCase();
  const actualSha = await fetchGithubMainSha();
  if (actualSha !== expectedSha) throw new Error('GitHub commit SHA does not match the notification');

  await notifyUpdater(actualSha);
  return { accepted: true, repository: UPDATE_REPO, branch: UPDATE_BRANCH, sha: actualSha };
}

export function authorizeUpdateRequest(authorization: string | undefined) {
  return timingSafeTokenEqual(
    authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : undefined,
    UPDATE_WEBHOOK_TOKEN,
  );
}
