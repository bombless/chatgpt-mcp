import crypto from 'node:crypto';
import type { Request } from 'express';

const PUBLIC_URL = (process.env.PUBLIC_URL ?? 'https://bombless.duckdns.org').replace(/\/$/, '');
const ACCESS_TOKEN_TTL_MS = Number(process.env.ACCESS_TOKEN_TTL_MS ?? 60 * 60 * 1000);
const REFRESH_TOKEN_TTL_MS = Number(process.env.REFRESH_TOKEN_TTL_MS ?? 30 * 24 * 60 * 60 * 1000);

type Client = { clientId: string; redirectUris: string[]; clientName?: string };
type Code = { clientId: string; redirectUri: string; codeChallenge?: string; expiresAt: number };
type Refresh = { clientId: string; expiresAt: number };

const clients = new Map<string, Client>();
const codes = new Map<string, Code>();
const accessTokens = new Map<string, { clientId: string; expiresAt: number }>();
const refreshTokens = new Map<string, Refresh>();

const random = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const html = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

export function oauthMetadata() {
  return {
    issuer: PUBLIC_URL,
    authorization_endpoint: `${PUBLIC_URL}/oauth/authorize`,
    token_endpoint: `${PUBLIC_URL}/oauth/token`,
    registration_endpoint: `${PUBLIC_URL}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['mcp'],
  };
}

export function protectedResourceMetadata() {
  return {
    resource: `${PUBLIC_URL}/mcp`,
    authorization_servers: [PUBLIC_URL],
    scopes_supported: ['mcp'],
    bearer_methods_supported: ['header'],
  };
}

export function registerClient(body: any) {
  console.log('[oauth] registerClient called, redirect_uris:', body?.redirect_uris);
  if (!Array.isArray(body?.redirect_uris) || body.redirect_uris.length === 0) throw new Error('redirect_uris is required');
  for (const uri of body.redirect_uris) {
    if (typeof uri !== 'string' || !/^https?:\/\//.test(uri)) throw new Error('redirect_uris must contain http(s) URLs');
  }
  const clientId = random(24);
  clients.set(clientId, { clientId, redirectUris: body.redirect_uris, clientName: body.client_name });
  console.log('[oauth] client registered:', clientId, 'name:', body.client_name);
  return { client_id: clientId, client_name: body.client_name ?? 'MCP Client', redirect_uris: body.redirect_uris, token_endpoint_auth_method: 'none' };
}

export function authorizationPage(req: Request) {
  const clientId = String(req.query.client_id ?? '');
  const redirectUri = String(req.query.redirect_uri ?? '');
  const state = String(req.query.state ?? '');
  const codeChallenge = req.query.code_challenge ? String(req.query.code_challenge) : undefined;
  const responseType = String(req.query.response_type ?? '');
  console.log('[oauth] authorizationPage client_id:', clientId, 'redirect_uri:', redirectUri, 'response_type:', responseType, 'pkce:', !!codeChallenge);
  const client = clients.get(clientId);
  if (!client || responseType !== 'code' || !client.redirectUris.includes(redirectUri)) {
    console.error('[oauth] authorizationPage invalid request - client found:', !!client, 'redirect_uri match:', client?.redirectUris.includes(redirectUri));
    return { status: 400, body: 'Invalid OAuth authorization request.' };
  }
  const action = `/oauth/authorize/approve?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}&code_challenge=${encodeURIComponent(codeChallenge ?? '')}`;
  return {
    status: 200,
    body: `<!doctype html><html><body style="font-family:sans-serif;max-width:640px;margin:60px auto"><h2>Authorize Windows MCP</h2><p>${html(client.clientName ?? 'An MCP client')} requests access to your Windows computer through <b>${html(PUBLIC_URL)}</b>.</p><ul><li>Read and write files within configured directories</li><li>Inspect connected Windows agents</li><li>Execute PowerShell only if enabled by the agent policy</li></ul><form method="post" action="${action}"><button style="padding:10px 18px">Authorize</button></form></body></html>`,
  };
}

export function approve(req: Request) {
  const { client_id, redirect_uri, state, code_challenge } = req.query as Record<string, string>;
  console.log('[oauth] approve client_id:', client_id, 'redirect_uri:', redirect_uri);
  const client = clients.get(client_id);
  if (!client || !client.redirectUris.includes(redirect_uri)) {
    console.error('[oauth] approve failed - client not found or redirect_uri mismatch');
    return { status: 400, body: 'Invalid OAuth authorization request.' };
  }
  const code = random();
  codes.set(code, { clientId: client_id, redirectUri: redirect_uri, codeChallenge: code_challenge || undefined, expiresAt: Date.now() + 5 * 60 * 1000 });
  console.log('[oauth] approve code issued:', code.slice(0, 8) + '...');
  const target = new URL(redirect_uri);
  target.searchParams.set('code', code);
  if (state) target.searchParams.set('state', state);
  return { status: 302, location: target.toString() };
}

function verifyPkce(verifier: string | undefined, challenge: string | undefined) {
  if (!challenge) return true;
  if (!verifier) return false;
  const actual = crypto.createHash('sha256').update(verifier).digest('base64url');
  return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(challenge));
}

export function exchangeToken(body: any) {
  const grantType = body?.grant_type;
  console.log('[oauth] exchangeToken grant_type:', grantType, 'client_id:', body?.client_id);
  if (grantType === 'authorization_code') {
    const item = codes.get(body.code);
    console.log('[oauth] auth_code exchange - code found:', !!item, 'expired:', item ? item.expiresAt < Date.now() : 'N/A');
    if (!item || item.expiresAt < Date.now()) throw new Error('invalid_grant');
    codes.delete(body.code);
    if (item.clientId !== body.client_id || item.redirectUri !== body.redirect_uri || !verifyPkce(body.code_verifier, item.codeChallenge)) {
      console.error('[oauth] auth_code exchange failed - client_id match:', item.clientId === body.client_id, 'redirect_uri match:', item.redirectUri === body.redirect_uri, 'pkce match:', verifyPkce(body.code_verifier, item.codeChallenge));
      throw new Error('invalid_grant');
    }
    return issueTokens(item.clientId);
  }
  if (grantType === 'refresh_token') {
    const item = refreshTokens.get(body.refresh_token);
    console.log('[oauth] refresh_token exchange - token found:', !!item, 'expired:', item ? item.expiresAt < Date.now() : 'N/A');
    if (!item || item.expiresAt < Date.now() || item.clientId !== body.client_id) throw new Error('invalid_grant');
    refreshTokens.delete(body.refresh_token);
    return issueTokens(item.clientId);
  }
  throw new Error('unsupported_grant_type');
}

function issueTokens(clientId: string) {
  const access = random();
  const refresh = random();
  accessTokens.set(access, { clientId, expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS });
  refreshTokens.set(refresh, { clientId, expiresAt: Date.now() + REFRESH_TOKEN_TTL_MS });
  return { access_token: access, token_type: 'Bearer', expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000), refresh_token: refresh, scope: 'mcp' };
}

export function validAccessToken(token: string | undefined) {
  if (!token) return false;
  const item = accessTokens.get(token);
  if (!item) { console.log('[oauth] validAccessToken: token not found'); return false; }
  if (item.expiresAt < Date.now()) { console.log('[oauth] validAccessToken: token expired'); accessTokens.delete(token); return false; }
  return true;
}
