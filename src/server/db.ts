import { access, readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
const DB_PATH = process.env.DB_PATH ?? './chatgpt-mcp.json';
export type DbState = {
  totp_config: { secret: string; created_at: number; updated_at: number } | null;
  oauth_clients: Record<string, { client_id: string; redirect_uris: string[]; client_name?: string | null; created_at: number }>;
  oauth_codes: Record<string, { code: string; client_id: string; redirect_uri: string; code_challenge?: string | null; expires_at: number }>;
  oauth_access_tokens: Record<string, { token: string; client_id: string; expires_at: number }>;
  oauth_refresh_tokens: Record<string, { token: string; client_id: string; expires_at: number }>;
  agents: Record<string, { agent_id: string; hostname: string; username: string; display_name: string; platform: string; version: string; first_seen_at: number; last_seen_at: number }>;
  agent_approvals: Record<string, { approval_id: string; agent_id: string; client_id: string; created_at: number; expires_at: number; used: boolean }>;
  agent_grants: Record<string, { grant_id: string; agent_id: string; client_id: string | null; created_at: number; expires_at: number }>;
};
const emptyDb = (): DbState => ({ totp_config: null, oauth_clients: {}, oauth_codes: {}, oauth_access_tokens: {}, oauth_refresh_tokens: {}, agents: {}, agent_approvals: {}, agent_grants: {} });
let dbPromise: Promise<DbState> | undefined; let writeQueue: Promise<void> = Promise.resolve();
async function persist(db: DbState) { await mkdir(dirname(DB_PATH), { recursive: true }); await writeFile(DB_PATH, JSON.stringify(db, null, 2) + '\n', 'utf8'); }
async function loadDb(): Promise<DbState> { try { await access(DB_PATH); const parsed = JSON.parse(await readFile(DB_PATH, 'utf8')) as Partial<DbState>; return { ...emptyDb(), ...parsed, oauth_clients: parsed.oauth_clients ?? {}, oauth_codes: parsed.oauth_codes ?? {}, oauth_access_tokens: parsed.oauth_access_tokens ?? {}, oauth_refresh_tokens: parsed.oauth_refresh_tokens ?? {}, agents: parsed.agents ?? {}, agent_approvals: parsed.agent_approvals ?? {}, agent_grants: parsed.agent_grants ?? {} }; } catch (error) { const db = emptyDb(); if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await persist(db); return db; } }
export function getDb(): Promise<DbState> { if (!dbPromise) dbPromise = loadDb(); return dbPromise; }
export async function saveDb(db: DbState) { writeQueue = writeQueue.then(() => persist(db)); await writeQueue; }
export async function closeDb() { await writeQueue; dbPromise = undefined; }
