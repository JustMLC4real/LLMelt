const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/** Houd diagnostiek bruikbaar zonder sessie-, account- of gesprekstokens te loggen. */
export function redactChatGptDiagnosticText(value: string) {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_JWT]')
    .replace(/([?&](?:token|key|code)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(UUID_PATTERN, '[REDACTED_ID]')
    .slice(0, 20_000);
}

export function redactChatGptDiagnosticValue(value: unknown, key = ''): unknown {
  if (/authorization|cookie|token|secret|api.?key|account.?id|conversation.?id/i.test(key)) {
    return '[REDACTED]';
  }
  if (typeof value === 'string') return redactChatGptDiagnosticText(value);
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => redactChatGptDiagnosticValue(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([childKey, child]) => [childKey, redactChatGptDiagnosticValue(child, childKey)]),
    );
  }
  return value;
}
