import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('persistent improvement suggestions are deduplicated, filterable, and status-updatable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-suggestions-'));
  const previousDbPath = process.env.DB_PATH;
  process.env.DB_PATH = join(dir, 'test-db.json');
  try {
    const dbModule = await import('../src/server/db.ts');
    await dbModule.closeDb();
    const store = await import('../src/server/improvement-suggestions.ts');
    const first = await store.submitImprovementSuggestion({ title: 'Add a combined workspace search tool', description: 'Repeatedly calling separate file listing and text search tools increases round trips. A combined tool could reduce latency.', category: 'tooling', priority: 'medium', source: 'session A' });
    assert.equal(first.deduplicated, false);
    const second = await store.submitImprovementSuggestion({ title: 'Add a combined workspace search tool', description: 'Observed again during another task.', category: 'tooling', priority: 'high', source: 'session B' });
    assert.equal(second.deduplicated, true);
    assert.equal(second.suggestion.occurrences, 2);
    assert.equal(second.suggestion.priority, 'high');
    assert.equal((await store.listImprovementSuggestions({ status: 'open' })).length, 1);
    const persisted = JSON.parse(await readFile(join(dir, 'test-db.json'), 'utf8'));
    assert.equal(persisted.improvement_suggestions.length, 1);
    await store.updateImprovementSuggestion({ id: first.suggestion.id, status: 'planned', note: 'Review for next iteration.' });
    assert.equal((await store.listImprovementSuggestions({ status: 'planned' })).length, 1);
    assert.equal((await store.listImprovementSuggestions({ status: 'open' })).length, 0);
  } finally {
    const dbModule = await import('../src/server/db.ts');
    await dbModule.closeDb();
    if (previousDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = previousDbPath;
    await rm(dir, { recursive: true, force: true });
  }
});