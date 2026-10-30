const AGENT_ID_PATTERN = /^[\p{L}\p{N}._-]{1,64}$/u;

/** Accept Unicode letters and numbers while keeping agent IDs path-safe and bounded. */
export function isValidAgentId(value: unknown): value is string {
  return typeof value === 'string' && AGENT_ID_PATTERN.test(value);
}
