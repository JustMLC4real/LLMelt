export interface ClaudeCliCatalogModel {
  id: string;
  name: string;
}

/**
 * Leest uitsluitend de modelwaarden die de geïnstalleerde Claude CLI zelf bij
 * `--model` publiceert. Voorbeeldnamen in andere helpsecties tellen niet mee.
 */
export function claudeCliModelsFromHelp(helpText: string): ClaudeCliCatalogModel[] {
  const block = helpText.match(/--model\s+<model>([\s\S]*?)(?=\n\s{2}-[a-zA-Z]|$)/)?.[1] || '';
  const ids = [...block.matchAll(/['"`]([a-zA-Z][a-zA-Z0-9._-]+)['"`]/g)]
    .map((match) => match[1]);
  return [...new Set(ids)]
    .filter((id) => !['model', 'latest'].includes(id.toLowerCase()))
    .map((id) => ({
      id,
      name: id
        .replace(/^claude-/, 'Claude ')
        .replace(/[-_]/g, ' ')
        .replace(/\b\w/g, (letter) => letter.toUpperCase()),
    }));
}
