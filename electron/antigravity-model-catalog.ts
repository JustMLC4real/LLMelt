export interface AntigravityCatalogModel {
  id: string;
  name: string;
}

/**
 * Normaliseert ook catalogi uit oudere LLMelt-versies. Die werden persistent
 * opgeslagen als `string[]`; nieuwere versies bewaren de live id én naam.
 * Onverwachte cache-inhoud mag nooit als een kapot modelobject de renderer in.
 */
export function normalizeAntigravityModelCatalog(value: unknown): AntigravityCatalogModel[] {
  if (!Array.isArray(value)) return [];

  const models = value.flatMap((entry): AntigravityCatalogModel[] => {
    if (typeof entry === 'string') {
      const id = entry.trim();
      return id ? [{ id, name: id }] : [];
    }
    if (!entry || typeof entry !== 'object') return [];

    const candidate = entry as { id?: unknown; name?: unknown };
    const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
    if (!id) return [];
    const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
    return [{ id, name: name || id }];
  });

  return [...new Map(models.map((model) => [model.id, model])).values()];
}

/**
 * Leest zowel de geldige commandowaarde als de live weergavenaam uit
 * `agy models`. De slug gaat naar `--model`; de door Antigravity gepubliceerde
 * naam gaat naar de UI. Oudere CLI-versies met één waarde per regel blijven
 * werken zonder dat LLMelt zelf een modelnaam hoeft te verzinnen.
 */
export function parseAntigravityModelCatalog(output: string): AntigravityCatalogModel[] {
  return normalizeAntigravityModelCatalog(output
    .split(/\r?\n/)
    .map((rawLine) => rawLine.trim())
    .filter((line) => line && !/^fetching available models\b/i.test(line))
    .map((line) => {
      const [commandValue, ...displayParts] = line.split(/\t+/);
      const id = commandValue.trim();
      return {
        id,
        name: displayParts.join(' ').trim() || id,
      };
    })
    .filter((model) => model.id));
}
