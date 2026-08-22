import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (relativePath: string) => readFileSync(new URL(relativePath, import.meta.url), 'utf8');

/**
 * Een chat verdwijnt uit de database voordat de renderer zijn id loslaat. Het
 * tokendashboard vroeg er dan alsnog om en kreeg een gegooide `Chat not found`
 * terug, waardoor ook de appbrede cijfers niet meer ververst werden.
 */
describe('tokendashboard bij een verdwenen chat', () => {
  it('behandelt een ontbrekende chat als lege context in plaats van een fout', () => {
    const handlers = read('../electron/ipc-handlers.ts');
    const contextUsage = handlers.slice(handlers.indexOf('async function getContextUsage('));

    expect(contextUsage).toContain('const chat = findChat(chatId);');
    expect(contextUsage).toContain("if (!chat) return { used: 0, total: 0, percent: 0, source: 'unknown' as const };");
    // requireChat blijft bestaan voor paden waar een ontbrekende chat wél fout is.
    expect(handlers).toContain('function requireChat(chatId: string) {');
    expect(contextUsage.slice(0, contextUsage.indexOf('\n}'))).not.toContain('requireChat(chatId)');
  });

  it('laat een mislukte chatopvraag de appbrede cijfers niet meeslepen', () => {
    const dashboard = read('./components/TokenDashboard.tsx');

    expect(dashboard).toContain('window.electronAPI.tokens.getDashboard(currentChatId).catch(() => null)');
  });
});
