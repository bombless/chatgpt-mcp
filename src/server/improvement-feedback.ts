import crypto from 'node:crypto';
import { getDb, saveDb, type ImprovementFeedbackEntry } from './db.js';

const categories = ['capability', 'usability', 'reliability', 'safety', 'performance', 'other'] as const;
const statuses = ['pending', 'accepted', 'in_progress', 'resolved', 'deferred'] as const;
const priorities = ['low', 'medium', 'high'] as const;

type SubmitInput = {
  title: string;
  description: string;
  category: typeof categories[number];
  priority: typeof priorities[number];
  relatedTool?: string;
  evidence?: string;
};

let mutationQueue: Promise<unknown> = Promise.resolve();
function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutationQueue.then(operation, operation);
  mutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export async function submitImprovement(input: SubmitInput) {
  return serialized(async () => {
    const db = await getDb();
    const now = Date.now();
    const duplicate = Object.values(db.improvement_feedback).find(entry =>
      entry.status !== 'resolved' &&
      normalized(entry.title) === normalized(input.title) &&
      entry.category === input.category
    );
    if (duplicate) {
      duplicate.occurrences += 1;
      duplicate.updatedAt = now;
      duplicate.lastObservedAt = now;
      if (input.evidence?.trim()) duplicate.evidence = [duplicate.evidence, input.evidence.trim()].filter(Boolean).join('\n').slice(-4000);
      if (!duplicate.relatedTool && input.relatedTool) duplicate.relatedTool = input.relatedTool;
      await saveDb(db);
      return { action: 'submitted', duplicate: true, suggestion: duplicate };
    }
    const suggestion: ImprovementFeedbackEntry = {
      id: crypto.randomUUID(),
      title: input.title.trim(),
      description: input.description.trim(),
      category: input.category,
      status: 'pending',
      priority: input.priority,
      relatedTool: input.relatedTool?.trim() || undefined,
      evidence: input.evidence?.trim() || undefined,
      occurrences: 1,
      createdAt: now,
      updatedAt: now,
      lastObservedAt: now,
    };
    db.improvement_feedback[suggestion.id] = suggestion;
    await saveDb(db);
    return { action: 'submitted', duplicate: false, suggestion };
  });
}

export async function listImprovements(input: { status?: typeof statuses[number]; category?: typeof categories[number]; limit: number }) {
  const db = await getDb();
  return Object.values(db.improvement_feedback)
    .filter(entry => !input.status || entry.status === input.status)
    .filter(entry => !input.category || entry.category === input.category)
    .sort((a, b) => b.lastObservedAt - a.lastObservedAt)
    .slice(0, input.limit);
}

export async function updateImprovement(input: { id: string; status?: typeof statuses[number]; priority?: typeof priorities[number] }) {
  return serialized(async () => {
    const db = await getDb();
    const suggestion = db.improvement_feedback[input.id];
    if (!suggestion) throw new Error(`Improvement suggestion not found: ${input.id}`);
    if (input.status) suggestion.status = input.status;
    if (input.priority) suggestion.priority = input.priority;
    suggestion.updatedAt = Date.now();
    await saveDb(db);
    return suggestion;
  });
}

export { categories as improvementCategories, statuses as improvementStatuses, priorities as improvementPriorities };
