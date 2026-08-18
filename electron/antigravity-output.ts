/** Haalt alleen een echt eindantwoord uit een Antigravity-transcript. */
export function antigravityFinalTranscriptText(transcript: string) {
  const rows = transcript
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean)
    .reverse();
  const final = rows.find((row: any) => (
    row.source === 'MODEL'
    && row.type === 'PLANNER_RESPONSE'
    && typeof row.content === 'string'
    && row.content.trim()
    && (!Array.isArray(row.tool_calls) || row.tool_calls.length === 0)
  ));
  return final?.content ? String(final.content).trim() : '';
}

/** Feitelijke UI-fallback als agy na tools met exitcode 0 maar zonder eindtekst sluit. */
export function antigravityPartialSummary(
  completed: number,
  failed: number,
  denied: number,
  unreported: number,
  language: UiLanguage = 'nl',
) {
  if (language === 'en') {
    const parts: string[] = [];
    if (completed > 0) parts.push(`${completed} tool ${completed === 1 ? 'action is' : 'actions are'} complete`);
    if (denied > 0) parts.push(`${denied} tool ${denied === 1 ? 'action was' : 'actions were'} denied`);
    if (unreported > 0) parts.push(`${unreported} tool ${unreported === 1 ? 'action has' : 'actions have'} no confirmed result`);
    const result = parts.length ? parts.join(', ') : 'tool execution is unconfirmed';
    const warning = failed > 0 ? ' Check the failed tool card(s) before continuing.' : '';
    return `Antigravity did not provide a separate final answer; ${result}.${warning}`;
  }
  const parts: string[] = [];
  if (completed > 0) parts.push(`${completed} ${completed === 1 ? 'toolactie is' : 'toolacties zijn'} afgerond`);
  if (denied > 0) parts.push(`${denied} ${denied === 1 ? 'toolactie is' : 'toolacties zijn'} geweigerd`);
  if (unreported > 0) parts.push(`${unreported} ${unreported === 1 ? 'toolactie heeft' : 'toolacties hebben'} geen bevestigd resultaat`);
  const result = parts.length ? parts.join(', ') : 'de tooluitvoering is niet bevestigd';
  const warning = failed > 0 ? ' Controleer de mislukte toolkaart(en) voordat je verdergaat.' : '';
  return `Antigravity leverde geen apart eindantwoord; ${result}.${warning}`;
}
import type { UiLanguage } from '../src/providers/types';
