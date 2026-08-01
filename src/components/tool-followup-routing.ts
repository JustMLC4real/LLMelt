export interface ToolFollowupRouting {
  requestId: string;
  suppressDeltas: true;
}

/**
 * Een herstel-/samenvattingsronde blijft onderdeel van de oorspronkelijke
 * chatbeurt. Status-events gebruiken daarom hetzelfde request-id, terwijl de
 * tekst pas na de toolkaarten als definitief antwoord wordt getoond.
 */
export function toolFollowupRouting(requestId: string): ToolFollowupRouting {
  const normalized = String(requestId || '').trim();
  if (!normalized) throw new Error('Een tool-follow-up vereist een requestId.');
  return {
    requestId: normalized,
    suppressDeltas: true,
  };
}
