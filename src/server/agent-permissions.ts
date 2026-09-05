import crypto from 'node:crypto';
import type { Request } from 'express';
import { getDb, saveDb } from './db.js';

const PUBLIC_URL = (process.env.PUBLIC_URL ?? 'https://bombless.duckdns.org').replace(/\/$/, '');
const APPROVAL_TTL_MS = Number(process.env.AGENT_APPROVAL_TTL_MS ?? 5 * 60 * 1000);
const GRANT_TTL_MS = Number(process.env.AGENT_GRANT_TTL_MS ?? 30 * 24 * 60 * 60 * 1000);
const random = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

export type AgentIdentity = {
  agent_id: string;
  hostname: string;
  username: string;
  display_name: string;
  platform: string;
  version: string;
  first_seen_at: number;
  last_seen_at: number;
};

function safe(value: unknown, fallback = '') { return typeof value === 'string' ? value.slice(0, 256) : fallback; }

export async function registerAgent(identity: Omit<AgentIdentity, 'first_seen_at' | 'last_seen_at'>) {
  const db = await getDb();
  const now = Date.now();
  const existing = db.agents[identity.agent_id];
  db.agents[identity.agent_id] = {
    ...identity,
    first_seen_at: existing?.first_seen_at ?? now,
    last_seen_at: now,
  };
  await saveDb(db);
  return db.agents[identity.agent_id];
}

export async function listAgentIdentities() {
  const db = await getDb();
  return Object.values(db.agents);
}

export async function createAgentApproval(req: Request, agentId: string) {
  const db = await getDb();
  const agent = db.agents[agentId];
  if (!agent) throw new Error(`Unknown agent '${agentId}'`);
  const approvalId = random(24);
  db.agent_approvals[approvalId] = {
    approval_id: approvalId,
    agent_id: agentId,
    client_id: String(req.query.client_id ?? ''),
    created_at: Date.now(),
    expires_at: Date.now() + APPROVAL_TTL_MS,
    used: false,
  };
  await saveDb(db);
  return { approval_id: approvalId, authorization_url: `${PUBLIC_URL}/agent-permission/authorize/${encodeURIComponent(approvalId)}`, expires_at: db.agent_approvals[approvalId].expires_at, agent };
}

export async function agentApprovalPage(approvalId: string) {
  const db = await getDb();
  const approval = db.agent_approvals[approvalId];
  if (!approval || approval.used || approval.expires_at < Date.now()) return { status: 400, body: '<h2>Authorization link expired</h2><p>Please ask ChatGPT to request a new link.</p>' };
  const agent = db.agents[approval.agent_id];
  if (!agent) return { status: 404, body: '<h2>Agent not found</h2>' };
  return {
    status: 200,
    body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize Agent</title></head><body style="font-family:system-ui,sans-serif;max-width:640px;margin:60px auto;padding:0 18px"><h2>Authorize Windows agent</h2><p>You are authorizing ChatGPT to use:</p><dl><dt><b>Computer</b></dt><dd>${escapeHtml(agent.display_name)}</dd><dt><b>Username</b></dt><dd>${escapeHtml(agent.username)}</dd><dt><b>Agent ID</b></dt><dd><code>${escapeHtml(agent.agent_id)}</code></dd></dl><p>The authorization is for this specific agent only.</p><form method="post" action="/agent-permission/authorize/${encodeURIComponent(approvalId)}"><button style="padding:10px 18px">Authorize this computer</button></form></body></html>`,
  };
}

export async function approveAgent(approvalId: string) {
  const db = await getDb();
  const approval = db.agent_approvals[approvalId];
  if (!approval || approval.used || approval.expires_at < Date.now()) return undefined;
  approval.used = true;
  const grantId = random(32);
  db.agent_grants[grantId] = { grant_id: grantId, agent_id: approval.agent_id, client_id: approval.client_id || null, created_at: Date.now(), expires_at: Date.now() + GRANT_TTL_MS };
  await saveDb(db);
  return db.agent_grants[grantId];
}

export async function hasAgentGrant(clientId: string | undefined, agentId: string) {
  if (!clientId) return false;
  const db = await getDb();
  return Object.values(db.agent_grants).some(g => g.agent_id === agentId && g.client_id === clientId && g.expires_at >= Date.now());
}

function escapeHtml(value: string) { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'); }

export function identityFromHello(message: { agentId: string; hostname: string; username?: string; displayName?: string; platform: string; version: string }) {
  return { agent_id: safe(message.agentId), hostname: safe(message.hostname), username: safe(message.username, 'unknown'), display_name: safe(message.displayName, safe(message.hostname, message.agentId)), platform: safe(message.platform), version: safe(message.version) };
}
