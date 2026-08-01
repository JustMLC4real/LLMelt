import type { AgentShell } from '../src/components/agent-commands';

/**
 * PowerShell 5.1 kent `&&` nog niet. Modellen gebruiken het desondanks vaak als
 * universele success-chain. Vertaal alleen operators buiten quotes en alleen
 * voor de werkelijk gekozen Windows PowerShell 5.1-shell.
 */
export function normalizePowerShell5ConditionalChain(
  command: string,
  shell: AgentShell,
  platform: NodeJS.Platform = process.platform,
) {
  const trimmed = command.trim();
  if (platform !== 'win32' || shell !== 'powershell' || !trimmed.includes('&&')) return trimmed;

  const segments = splitUnquotedAndAnd(trimmed);
  if (segments.length < 2 || segments.some((segment) => !segment.trim())) return trimmed;
  return segments
    .map((segment, index) => index === segments.length - 1
      ? segment.trim()
      : `${segment.trim()}; if (-not $?) { exit 1 }`)
    .join('; ');
}

function splitUnquotedAndAnd(command: string) {
  const segments: string[] = [];
  let start = 0;
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (let index = 0; index < command.length - 1; index += 1) {
    const character = command[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '`' && quote === '"') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        if (quote === "'" && command[index + 1] === "'") {
          index += 1;
          continue;
        }
        quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === '&' && command[index + 1] === '&') {
      segments.push(command.slice(start, index));
      start = index + 2;
      index += 1;
    }
  }
  if (!segments.length) return [command];
  segments.push(command.slice(start));
  return segments;
}
