export interface ClaudeCliCatalogModel {
  id: string;
  name: string;
  resolvedModel?: string;
  supportedReasoningEfforts?: string[];
}

/** De modelmetadata die Claude Code via de officiële Agent SDK publiceert. */
export interface ClaudeCliSupportedModel {
  value: string;
  resolvedModel?: string;
  displayName: string;
  description: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
}

/**
 * Normaliseert Claude Code's officiële `supportedModels()`-antwoord voor de UI.
 * `default` en een expliciete familie-alias kunnen naar hetzelfde model wijzen;
 * in dat geval tonen we alleen de expliciete keuze (bijvoorbeeld Sonnet).
 */
export function claudeCliModelsFromSupportedModels(
  models: ClaudeCliSupportedModel[],
): ClaudeCliCatalogModel[] {
  const liveModels = models
    .map((model) => ({
      ...model,
      value: model.value?.trim(),
      resolvedModel: model.resolvedModel?.trim(),
    }))
    .filter((model) => model.value);
  const explicitResolvedModels = new Set(
    liveModels
      .filter((model) => model.value.toLowerCase() !== 'default')
      .map((model) => (model.resolvedModel || model.value).toLowerCase()),
  );
  const emitted = new Set<string>();

  return liveModels.flatMap((model) => {
    const resolvedKey = (model.resolvedModel || model.value).toLowerCase();
    if (model.value.toLowerCase() === 'default' && explicitResolvedModels.has(resolvedKey)) return [];
    if (emitted.has(resolvedKey)) return [];
    emitted.add(resolvedKey);

    return [{
      // `value` is volgens Claude zelf de identifier die callers moeten sturen.
      id: model.value,
      name: claudeSupportedModelName(model),
      resolvedModel: model.resolvedModel,
      supportedReasoningEfforts: model.supportsEffort
        ? [...new Set(model.supportedEffortLevels || [])]
        : [],
    }];
  });
}

/**
 * Leest uitsluitend de modelwaarden die de geïnstalleerde Claude CLI zelf bij
 * `--model` publiceert. Voorbeeldnamen in andere helpsecties tellen niet mee.
 */
export function claudeCliModelsFromHelp(helpText: string): ClaudeCliCatalogModel[] {
  const block = helpText.match(/--model\s+<model>([\s\S]*?)(?=\n\s{2}-[a-zA-Z]|$)/)?.[1] || '';
  const ids = [...block.matchAll(/['"`]([a-zA-Z][a-zA-Z0-9._-]+)['"`]/g)]
    .map((match) => match[1]);
  const advertised = [...new Set(ids)]
    .filter((id) => !['model', 'latest'].includes(id.toLowerCase()));
  const fullByAlias = new Map<string, string>();
  for (const id of advertised) {
    const family = id.match(/^claude-([a-z][a-z0-9]*)-/i)?.[1]?.toLowerCase();
    if (family && !fullByAlias.has(family)) fullByAlias.set(family, id);
  }

  // Als de help zowel een alias als de bijbehorende volledige ID noemt, toon
  // die als één model op de positie van de alias. Zo worden `fable` en
  // `claude-fable-5` geen twee kunstmatig verschillende keuzes.
  const emitted = new Set<string>();
  return advertised.flatMap((advertisedId) => {
    const id = fullByAlias.get(advertisedId.toLowerCase()) || advertisedId;
    if (emitted.has(id)) return [];
    emitted.add(id);
    return [{ id, name: claudeModelName(id) }];
  });
}

function claudeModelName(id: string) {
  const parts = id
    .replace(/^claude-/i, '')
    .replace(/-\d{8}$/i, '')
    .replace(/\[.+?\]$/i, '')
    .split(/[-_]+/)
    .filter(Boolean);
  const words: string[] = [];
  for (const part of parts) {
    if (/^\d+$/.test(part) && /^\d+(?:\.\d+)*$/.test(words[words.length - 1] || '')) {
      words[words.length - 1] = `${words[words.length - 1]}.${part}`;
    } else {
      words.push(/^\d/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1).toLowerCase());
    }
  }
  return words.join(' ');
}

function claudeSupportedModelName(model: ClaudeCliSupportedModel) {
  const descriptionTitle = model.description?.split(/\s*[·•]\s*/)[0]?.trim();
  if (descriptionTitle && /\d/.test(descriptionTitle)) return descriptionTitle;

  const resolvedName = claudeModelName(model.resolvedModel || model.value);
  if (resolvedName && !/^Default(?:\s|$)/i.test(resolvedName)) return resolvedName;

  return model.displayName?.replace(/\s*\(recommended\)\s*$/i, '').trim() || resolvedName;
}
