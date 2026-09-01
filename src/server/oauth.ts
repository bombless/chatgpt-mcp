import crypto from 'node:crypto';
import type { Request } from 'express';
import { getDb, saveDb } from './db.js';
import { verifyTotp } from './totp.js';
import './output-schema-hook.js';

const PUBLIC_URL = (process.env.PUBLIC_URL ?? 'https://bombless.duckdns.org').replace(/\/$/, '');
const ACCESS_TOKEN_TTL_MS = Number(process.env.ACCESS_TOKEN_TTL_MS ?? 60 * 60 * 1000);
const REFRESH_TOKEN_TTL_MS = Number(process.env.REFRESH_TOKEN_TTL_MS ?? 30 * 24 * 60 * 60 * 1000);
const OAUTH_DEBUG = process.env.OAUTH_DEBUG === '1' || process.env.DEBUG_OAUTH === '1';
const random = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const html = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const short = (value: unknown) => typeof value === 'string' ? `${value.slice(0, 12)}${value.length > 12 ? '…' : ''}` : value;
function oauthDebug(event: string, details: Record<string, unknown> = {}) { if (OAUTH_DEBUG) console.log(`[oauth] ${event} ${JSON.stringify(details)}`); }

type Client = { clientId: string; redirectUris: string[]; clientName?: string };

export function oauthMetadata() {
  const metadata = { issuer: PUBLIC_URL, authorization_endpoint: `${PUBLIC_URL}/oauth/authorize`, token_endpoint: `${PUBLIC_URL}/oauth/token`, registration_endpoint: `${PUBLIC_URL}/oauth/register`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], scopes_supported: ['mcp'] };
  oauthDebug('metadata', { issuer: metadata.issuer });
  return metadata;
}
export function protectedResourceMetadata() {
  const metadata = { resource: `${PUBLIC_URL}/mcp`, authorization_servers: [PUBLIC_URL], scopes_supported: ['mcp'], bearer_methods_supported: ['header'] };
  oauthDebug('protected-resource-metadata', { resource: metadata.resource });
  return metadata;
}

export async function registerClient(body: any) {
  oauthDebug('register:start', { clientName: body?.client_name, redirectUris: Array.isArray(body?.redirect_uris) ? body.redirect_uris : undefined });
  if (!Array.isArray(body?.redirect_uris) || body.redirect_uris.length === 0) throw new Error('redirect_uris is required');
  for (const uri of body.redirect_uris) if (typeof uri !== 'string' || !/^https?:\/\//.test(uri)) throw new Error('redirect_uris must contain http(s) URLs');
  const clientId = random(24), db = await getDb(), now = Date.now();
  db.oauth_clients[clientId] = { client_id: clientId, redirect_uris: body.redirect_uris, client_name: body.client_name ?? null, created_at: now };
  await saveDb(db);
  oauthDebug('register:success', { clientId: short(clientId), redirectUriCount: body.redirect_uris.length });
  return { client_id: clientId, client_name: body.client_name ?? 'MCP Client', redirect_uris: body.redirect_uris, token_endpoint_auth_method: 'none' };
}

async function getClient(clientId: string): Promise<Client | undefined> {
  const row = (await getDb()).oauth_clients[clientId];
  return row ? { clientId: row.client_id, redirectUris: row.redirect_uris, clientName: row.client_name ?? undefined } : undefined;
}
async function getTotpSecret() { return (await getDb()).totp_config?.secret; }

function isChatGptConnectorRedirect(uri: string) {
  try { const url = new URL(uri); return url.protocol === 'https:' && url.hostname === 'chatgpt.com' && url.pathname.startsWith('/connector/oauth/'); } catch { return false; }
}
async function ensurePublicClient(clientId: string, redirectUri: string) {
  const db = await getDb();
  const existing = db.oauth_clients[clientId];
  if (existing) return { client: { clientId: existing.client_id, redirectUris: existing.redirect_uris, clientName: existing.client_name ?? undefined } as Client, created: false };
  if (!isChatGptConnectorRedirect(redirectUri)) return { client: undefined, created: false };
  const now = Date.now();
  db.oauth_clients[clientId] = { client_id: clientId, redirect_uris: [redirectUri], client_name: 'ChatGPT', created_at: now };
  await saveDb(db);
  const client: Client = { clientId, redirectUris: [redirectUri], clientName: 'ChatGPT' };
  oauthDebug('authorize:implicit-public-client', { clientId: short(clientId), redirectUri });
  return { client, created: true };
}

export async function authorizationPage(req: Request) {
  const clientId = String(req.query.client_id ?? ''), redirectUri = String(req.query.redirect_uri ?? ''), state = String(req.query.state ?? ''), codeChallenge = req.query.code_challenge ? String(req.query.code_challenge) : undefined, responseType = String(req.query.response_type ?? ''), codeChallengeMethod = req.query.code_challenge_method ? String(req.query.code_challenge_method) : '', resource = req.query.resource ? String(req.query.resource) : undefined;
  let client = await getClient(clientId);
  const existingClient = Boolean(client);
  if (!client) client = (await ensurePublicClient(clientId, redirectUri)).client;
  const redirectUriAllowed = Boolean(client?.redirectUris.includes(redirectUri));
  oauthDebug('authorize:start', { clientId: short(clientId), redirectUri, responseType, hasState: Boolean(state), hasCodeChallenge: Boolean(codeChallenge), codeChallengeMethod, resource, clientFound: Boolean(client), existingClient, implicitPublicClient: !existingClient && Boolean(client), redirectUriAllowed });
  const secret = await getTotpSecret();
  if (!client || responseType !== 'code' || !redirectUriAllowed || codeChallengeMethod !== 'S256' || !codeChallenge) { oauthDebug('authorize:rejected', { clientId: short(clientId), responseType, redirectUri, reason: !client ? 'unknown_client' : responseType !== 'code' ? 'unsupported_response_type' : !redirectUriAllowed ? 'redirect_uri_mismatch' : codeChallengeMethod !== 'S256' ? 'unsupported_pkce_method' : 'missing_code_challenge' }); return { status: 400, body: 'Invalid OAuth authorization request.' }; }
  if (!secret) return { status: 503, body: 'MCP owner authentication is not configured. Open the local admin page at / and configure Authenticator first.' };
  const action = `/oauth/authorize/approve?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}&code_challenge=${encodeURIComponent(codeChallenge)}`;
  oauthDebug('authorize:page', { clientId: short(clientId), redirectUri });
  return { status: 200, body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize Windows MCP</title></head><body style="font-family:system-ui,sans-serif;max-width:640px;margin:60px auto;padding:0 18px"><h2>Authorize Windows MCP</h2><p>${html(client.clientName ?? 'An MCP client')} requests access to your Windows computer through <b>${html(PUBLIC_URL)}</b>.</p><ul><li>Read and write files within configured directories</li><li>Inspect connected Windows agents</li><li>Execute PowerShell only if enabled by the agent policy</li></ul><form method="post" action="${action}"><label>Authenticator code</label><input name="totp" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required style="display:block;font-size:28px;letter-spacing:8px;width:180px;padding:8px;margin:12px 0"><button style="padding:10px 18px">Authorize</button></form></body></html>` };
}

export async function approve(req: Request) {
  const { client_id, redirect_uri, state, code_challenge } = req.query as Record<string, string>;
  const client = await getClient(client_id), secret = await getTotpSecret();
  oauthDebug('authorize:approve:start', { clientId: short(client_id), redirectUri: redirect_uri, hasState: Boolean(state), hasCodeChallenge: Boolean(code_challenge), clientFound: Boolean(client), redirectUriAllowed: Boolean(client?.redirectUris.includes(redirect_uri)) });
  if (!client || !client.redirectUris.includes(redirect_uri) || !secret || !code_challenge) { oauthDebug('authorize:approve:rejected', { clientId: short(client_id), redirectUri: redirect_uri }); return { status: 400, body: 'Invalid OAuth authorization request.' }; }
  const token = String(req.body?.totp ?? '');
  if (!verifyTotp(secret, token)) return { status: 401, body: '<!doctype html><html><body style="font-family:system-ui,sans-serif;max-width:640px;margin:60px auto"><h2>Authorization denied</h2><p>Invalid or expired Authenticator code.</p><p><a href="javascript:history.back()">Try again</a></p></body></html>' };
  const code = random(), db = await getDb();
  db.oauth_codes[code] = { code, client_id, redirect_uri, code_challenge, expires_at: Date.now() + 5 * 60 * 1000 };
  await saveDb(db);
  const target = new URL(redirect_uri); target.searchParams.set('code', code); if (state) target.searchParams.set('state', state);
  oauthDebug('authorize:approve:success', { clientId: short(client_id), redirectUri: redirect_uri, code: short(code), redirectTarget: target.origin + target.pathname, hasState: Boolean(state) });
  return { status: 302, location: target.toString() };
}

function verifyPkce(verifier: string | undefined, challenge: string | undefined) {
  if (!challenge) { oauthDebug('pkce:failed', { reason: 'no_challenge' }); return false; }
  if (!verifier) { oauthDebug('pkce:failed', { reason: 'missing_verifier' }); return false; }
  const actual = crypto.createHash('sha256').update(verifier).digest('base64url');
  if (actual.length !== challenge.length) { oauthDebug('pkce:failed', { reason: 'length_mismatch', actualLength: actual.length, challengeLength: challenge.length }); return false; }
  const valid = crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(challenge)); oauthDebug('pkce:verified', { valid }); return valid;
}

export async function exchangeToken(body: any) {
  const db = await getDb();
  oauthDebug('token:start', { grantType: body?.grant_type, clientId: short(body?.client_id), redirectUri: body?.redirect_uri, hasCode: Boolean(body?.code), hasCodeVerifier: Boolean(body?.code_verifier), hasRefreshToken: Boolean(body?.refresh_token) });
  if (body?.grant_type === 'authorization_code') {
    const item = db.oauth_codes[body.code];
    oauthDebug('token:authorization-code:lookup', { found: Boolean(item), expired: Boolean(item && item.expires_at < Date.now()), storedClientId: short(item?.client_id), requestedClientId: short(body?.client_id), redirectUriMatch: Boolean(item && item.redirect_uri === body?.redirect_uri), hasCodeChallenge: Boolean(item?.code_challenge) });
    if (!item || item.expires_at < Date.now()) throw new Error('invalid_grant');
    delete db.oauth_codes[body.code];
    if (item.client_id !== body.client_id || item.redirect_uri !== body.redirect_uri || !verifyPkce(body.code_verifier, item.code_challenge ?? undefined)) { oauthDebug('token:authorization-code:rejected', { clientIdMatch: item.client_id === body.client_id, redirectUriMatch: item.redirect_uri === body.redirect_uri }); throw new Error('invalid_grant'); }
    await saveDb(db); const tokens = await issueTokens(item.client_id); oauthDebug('token:authorization-code:success', { clientId: short(item.client_id) }); return tokens;
  }
  if (body?.grant_type === 'refresh_token') {
    const item = db.oauth_refresh_tokens[body.refresh_token];
    oauthDebug('token:refresh:lookup', { found: Boolean(item), expired: Boolean(item && item.expires_at < Date.now()), clientIdMatch: Boolean(item && item.client_id === body?.client_id) });
    if (!item || item.expires_at < Date.now() || item.client_id !== body.client_id) throw new Error('invalid_grant');
    delete db.oauth_refresh_tokens[body.refresh_token]; await saveDb(db); const tokens = await issueTokens(item.client_id); oauthDebug('token:refresh:success', { clientId: short(item.client_id) }); return tokens;
  }
  oauthDebug('token:rejected', { reason: 'unsupported_grant_type', grantType: body?.grant_type });
  throw new Error('unsupported_grant_type');
}

async function issueTokens(clientId: string) {
  const access = random(), refresh = random(), db = await getDb();
  db.oauth_access_tokens[access] = { token: access, client_id: clientId, expires_at: Date.now() + ACCESS_TOKEN_TTL_MS };
  db.oauth_refresh_tokens[refresh] = { token: refresh, client_id: clientId, expires_at: Date.now() + REFRESH_TOKEN_TTL_MS };
  await saveDb(db);
  oauthDebug('tokens:issued', { clientId: short(clientId), accessToken: short(access), refreshToken: short(refresh), accessExpiresInSeconds: Math.floor(ACCESS_TOKEN_TTL_MS / 1000) });
  return { access_token: access, token_type: 'Bearer', expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000), refresh_token: refresh, scope: 'mcp' };
}

export async function validAccessToken(token: string | undefined) {
  if (!token) { oauthDebug('access-token:missing'); return false; }
  const db = await getDb(), item = db.oauth_access_tokens[token];
  if (!item) { oauthDebug('access-token:invalid', { token: short(token) }); return false; }
  if (item.expires_at < Date.now()) { delete db.oauth_access_tokens[token]; await saveDb(db); oauthDebug('access-token:expired', { clientId: short(item.client_id), token: short(token) }); return false; }
  oauthDebug('access-token:valid', { clientId: short(item.client_id), token: short(token) });
  return true;
}
