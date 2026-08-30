import sqlite3 from 'sqlite3';
import { open, type Database } from 'sqlite';

const DB_PATH = process.env.DB_PATH ?? './chatgpt-mcp.sqlite';
let dbPromise: Promise<Database> | undefined;

export function getDb() {
  if (!dbPromise) {
    dbPromise = open({ filename: DB_PATH, driver: sqlite3.Database }).then(async db => {
      await db.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS totp_config (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          secret TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS oauth_clients (
          client_id TEXT PRIMARY KEY,
          redirect_uris TEXT NOT NULL,
          client_name TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS oauth_codes (
          code TEXT PRIMARY KEY,
          client_id TEXT NOT NULL,
          redirect_uri TEXT NOT NULL,
          code_challenge TEXT,
          expires_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS oauth_access_tokens (
          token TEXT PRIMARY KEY,
          client_id TEXT NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
          token TEXT PRIMARY KEY,
          client_id TEXT NOT NULL,
          expires_at INTEGER NOT NULL
        );
      `);
      return db;
    });
  }
  return dbPromise;
}

export async function closeDb() {
  if (dbPromise) {
    const db = await dbPromise;
    await db.close();
    dbPromise = undefined;
  }
}
