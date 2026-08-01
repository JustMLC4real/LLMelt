export interface OllamaTitleModel {
  name?: string;
  model?: string;
  size?: number;
}

/**
 * Uitsluitend de bootstrap wanneer de live catalogus leeg is. Zodra er lokale
 * modellen zijn, kiest `selectOllamaTitleModel` dynamisch uit die catalogus.
 */
export const DEFAULT_OLLAMA_TITLE_MODEL = 'qwen3:1.7b';

export interface OllamaTitleSetupStatus {
  ready: boolean;
  runtimeAvailable: boolean;
  modelAvailable: boolean;
  model: string;
  installedModels: string[];
}

function modelName(model: OllamaTitleModel) {
  return String(model.name || model.model || '').replace(/^ollama:/, '').trim();
}

/**
 * Titels hebben geen groot code- of reasoningmodel nodig. Kies daarom uit de
 * live Ollama-catalogus het kleinste algemene model; een expliciete instelling
 * blijft altijd leidend.
 */
export function selectOllamaTitleModel(
  configured: unknown,
  models: OllamaTitleModel[],
): string | null {
  const preferred = String(configured || '').replace(/^ollama:/, '').trim();
  if (preferred) return preferred;

  const candidates = models
    .map((model, index) => ({
      name: modelName(model),
      size: Number.isFinite(Number(model.size)) && Number(model.size) > 0
        ? Number(model.size)
        : Number.POSITIVE_INFINITY,
      index,
    }))
    .filter((model) => model.name);
  if (!candidates.length) return null;

  const general = candidates.filter((model) => !/(?:^|[-_.:])(code|coder)(?:$|[-_.:])/i.test(model.name));
  return [...(general.length ? general : candidates)]
    .sort((a, b) => a.size - b.size || a.index - b.index)[0]?.name || null;
}

export function resolveOllamaTitleSetup(
  configured: unknown,
  models: OllamaTitleModel[],
  runtimeAvailable: boolean,
): OllamaTitleSetupStatus {
  const installedModels = models.map(modelName).filter(Boolean);
  const configuredModel = String(configured || '').replace(/^ollama:/, '').trim();
  const configuredInstalled = configuredModel
    ? installedModels.find((name) => name.toLocaleLowerCase() === configuredModel.toLocaleLowerCase())
    : undefined;
  const installedModel = configuredInstalled || (!configuredModel
    ? selectOllamaTitleModel(undefined, models)
    : null);
  const model = installedModel || configuredModel || DEFAULT_OLLAMA_TITLE_MODEL;

  return {
    ready: runtimeAvailable && !!installedModel,
    runtimeAvailable,
    modelAvailable: !!installedModel,
    model,
    installedModels,
  };
}
