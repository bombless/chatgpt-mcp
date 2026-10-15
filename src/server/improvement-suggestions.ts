import { randomUUID } from 'node:crypto';
import { getDb, saveDb } from './db.js';

export const suggestionCategories = ['tooling', 'reliability', 'performance', 'usability', 'security', 'other'] as const;
export const suggestionPriorities = ['low', 'medium', 'high'] as const;
export const suggestionStatuses = ['open', 'planned', 'done', 'wont_fix'] as const;
export type SuggestionCategory = typeof suggestionCategories[number];
export type SuggestionPriority = typeof suggestionPriorities[number];
export type SuggestionStatus = typeof suggestionStatuses[number];

export async function submitImprovementSuggestion(input: { title: string; description: string; category: SuggestionCategory; priority: SuggestionPriority; source?: string }) {
  const db = await getDb();
  const title = input.title.trim();
  const description = input.description.trim();
  const normalized = title.toLocaleLowerCase();
  const existing = db.improvement_suggestions.find(item => item.title.trim().toLocaleLowerCase() === normalized && item.status !== 'done' && item.status !== 'wont_fix');
  const now = Date.now();
  if (existing) {
    existing.occurrences += 1;
    existing.updated_at = now;
    if (input.priority === 'high') existing.priority = 'high';
    if (description && !existing.description.includes(description)) existing.description = `${existing.description}\n\nAdditional observation: ${description}`.trim();
    if (input.source && input.source !== existing.source) existing.source = [existing.source, input.source].filter(Boolean).join(', ').slice(0, 500);
    await saveDb(db);
    return { suggestion: existing, deduplicated: true };
  }
  const suggestion = { id: randomUUID(), title, description, category: input.category, priority: input.priority, status: 'open' as const, ...(input.source ? { source: input.source } : {}), created_at: now, updated_at: now, occurrences: 1 };
  db.improvement_suggestions.unshift(suggestion);
  await saveDb(db);
  return { suggestion, deduplicated: false };
}

export async function listImprovementSuggestions(input: { status?: SuggestionStatus; category?: SuggestionCategory; limit?: number } = {}) {
  const db = await getDb();
  return db.improvement_suggestions.filter(item => !input.status || item.status === input.status).filter(item => !input.category || item.category === input.category).slice(0, input.limit ?? 100);
}

export async function updateImprovementSuggestion(input: { id: string; status: SuggestionStatus; note?: string }) {
  const db = await getDb();
  const suggestion = db.improvement_suggestions.find(item => item.id === input.id);
  if (!suggestion) throw new Error(`Improvement suggestion not found: ${input.id}`);
  suggestion.status = input.status;
  suggestion.updated_at = Date.now();
  if (input.note?.trim()) suggestion.description = `${suggestion.description}\n\nStatus update: ${input.note.trim()}`;
  await saveDb(db);
  return suggestion;
}