import type {
  OllamaInstalledModel,
  OllamaLibraryModel,
  OllamaLibraryTag,
  OllamaModelPullProgress,
  UiLanguage,
} from '../src/providers/types';
import { localizedText } from '../src/i18n/language';

type FetchLike = typeof fetch;

type OllamaTagRecord = {
  name?: unknown;
  model?: unknown;
  size?: unknown;
  digest?: unknown;
  modified_at?: unknown;
  details?: {
    format?: unknown;
    family?: unknown;
    parameter_size?: unknown;
    quantization_level?: unknown;
  };
};

const OLLAMA_LIBRARY_ORIGIN = 'https://ollama.com';
const LIBRARY_CAPABILITIES = new Set(['cloud', 'embedding', 'vision', 'tools', 'thinking', 'audio']);
const MAX_LIBRARY_RESPONSE_BYTES = 3 * 1024 * 1024;

export function assertOllamaModelName(value: unknown, language: UiLanguage = 'nl') {
  const model = String(value || '').trim();
  if (!model || model.length > 200) {
    throw new Error(localizedText(language, 'Voer een geldige Ollama-modelnaam in.', 'Enter a valid Ollama model name.'));
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*(?::[A-Za-z0-9][A-Za-z0-9._-]*)?$/.test(model)) {
    throw new Error(localizedText(language, 'De Ollama-modelnaam bevat ongeldige tekens.', 'The Ollama model name contains invalid characters.'));
  }
  return model;
}

export async function listInstalledOllamaModels(
  baseUrl: string,
  fetchImpl: FetchLike = fetch,
  language: UiLanguage = 'nl',
): Promise<OllamaInstalledModel[]> {
  const models = await readOllamaTags(baseUrl, fetchImpl, language);
  const details: Array<Record<string, unknown> | undefined> = new Array(models.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < models.length) {
      const index = nextIndex++;
      const name = ollamaTagName(models[index]);
      if (!name) continue;
      try {
        const response = await fetchImpl(`${trimBaseUrl(baseUrl)}/api/show`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(7_500),
          body: JSON.stringify({ model: name, verbose: false }),
        });
        if (response.ok) details[index] = await response.json() as Record<string, unknown>;
      } catch {
        // `/api/tags` blijft autoritatief; extra capabilities zijn best-effort.
      }
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(4, Math.max(1, models.length)) },
    () => worker(),
  ));

  return models
    .map((model, index): OllamaInstalledModel | null => {
      const name = ollamaTagName(model);
      if (!name) return null;
      const show = details[index] || {};
      const tagDetails = model.details || {};
      const showDetails = objectValue(show.details);
      const capabilities = Array.isArray(show.capabilities)
        ? show.capabilities.filter((value): value is string => typeof value === 'string')
        : [];
      return {
        name,
        size: finiteNumber(model.size),
        digest: stringValue(model.digest),
        modifiedAt: stringValue(model.modified_at),
        format: stringValue(showDetails.format) || stringValue(tagDetails.format),
        family: stringValue(showDetails.family) || stringValue(tagDetails.family),
        parameterSize: stringValue(showDetails.parameter_size) || stringValue(tagDetails.parameter_size),
        quantizationLevel: stringValue(showDetails.quantization_level) || stringValue(tagDetails.quantization_level),
        capabilities,
        contextWindow: ollamaContextWindow(show),
      };
    })
    .filter((model): model is OllamaInstalledModel => !!model)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
}

export async function searchOllamaLibrary(
  query: string,
  fetchImpl: FetchLike = fetch,
  language: UiLanguage = 'nl',
): Promise<OllamaLibraryModel[]> {
  const normalized = query.trim();
  if (normalized.length < 2) return [];
  if (normalized.length > 80) throw new Error(localizedText(language, 'De zoekopdracht is te lang.', 'The search query is too long.'));
  const url = new URL('/search', OLLAMA_LIBRARY_ORIGIN);
  url.searchParams.set('q', normalized);
  const html = await fetchOfficialLibraryHtml(url, fetchImpl, language);
  return parseOllamaLibrarySearchHtml(html);
}

export async function listOllamaLibraryTags(
  libraryPath: string,
  fetchImpl: FetchLike = fetch,
  language: UiLanguage = 'nl',
): Promise<OllamaLibraryTag[]> {
  const url = officialLibraryTagsUrl(libraryPath, language);
  const html = await fetchOfficialLibraryHtml(url, fetchImpl, language);
  return parseOllamaLibraryTagsHtml(html);
}

export async function pullOllamaModel(
  baseUrl: string,
  requestedModel: unknown,
  signal: AbortSignal,
  onProgress: (progress: OllamaModelPullProgress) => void,
  fetchImpl: FetchLike = fetch,
  waitImpl: (milliseconds: number, signal: AbortSignal, language?: UiLanguage) => Promise<void> = waitForOllamaPullRetry,
  language: UiLanguage = 'nl',
) {
  const model = assertOllamaModelName(requestedModel, language);
  onProgress({
    model,
    phase: 'resolving',
    status: localizedText(language, `${model} voorbereiden...`, `Preparing ${model}...`),
    percent: 0,
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await pullOllamaModelAttempt(baseUrl, model, signal, onProgress, fetchImpl, language);
    } catch (error) {
      if (signal.aborted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (!isRetryableOllamaRegistryError(message) || attempt >= 2) {
        throw new Error(friendlyOllamaPullError(model, message, language));
      }
      onProgress({
        model,
        phase: 'resolving',
        status: localizedText(
          language,
          `Ollama Registry antwoordde tijdelijk niet goed; poging ${attempt + 2} van 3...`,
          `Ollama Registry returned a temporary error; attempt ${attempt + 2} of 3...`,
        ),
      });
      await waitImpl(attempt === 0 ? 750 : 2_000, signal, language);
    }
  }
  throw new Error(localizedText(language, `Ollama-model ${model} kon niet worden gedownload.`, `Ollama model ${model} could not be downloaded.`));
}

async function pullOllamaModelAttempt(
  baseUrl: string,
  model: string,
  signal: AbortSignal,
  onProgress: (progress: OllamaModelPullProgress) => void,
  fetchImpl: FetchLike,
  language: UiLanguage,
) {
  const response = await fetchImpl(`${trimBaseUrl(baseUrl)}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({ model, stream: true }),
  });
  if (!response.ok || !response.body) {
    const body = await response.text().catch(() => '');
    throw new Error(body || localizedText(language, `Ollama-model downloaden mislukt (${response.status}).`, `Downloading the Ollama model failed (${response.status}).`));
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const startedAt = Date.now();
  let buffer = '';
  let succeeded = false;
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = done ? '' : lines.pop() || '';
    for (const line of lines) {
      const update = parseOllamaPullLine(line);
      if (!update) continue;
      if (update.error) throw new Error(String(update.error));
      const transferred = positiveNumber(update.completed);
      const total = positiveNumber(update.total);
      const percent = total && transferred !== undefined
        ? Math.min(100, Math.max(0, Math.round((transferred / total) * 100)))
        : undefined;
      const elapsedSeconds = Math.max(0.25, (Date.now() - startedAt) / 1000);
      const status = String(update.status || '');
      if (status.toLocaleLowerCase() === 'success') succeeded = true;
      onProgress({
        model,
        phase: ollamaPullPhase(status),
        status: ollamaPullStatus(status, model, language),
        percent,
        transferred,
        total,
        bytesPerSecond: transferred === undefined ? undefined : Math.round(transferred / elapsedSeconds),
      });
    }
    if (done) break;
  }

  if (!succeeded && !await ollamaModelExists(baseUrl, model, fetchImpl, language)) {
    throw new Error(localizedText(language, `Ollama bevestigde de installatie van ${model} niet.`, `Ollama did not confirm the installation of ${model}.`));
  }
  onProgress({
    model,
    phase: 'success',
    status: localizedText(language, `${model} is geïnstalleerd.`, `${model} is installed.`),
    percent: 100,
  });
  return model;
}

export function isRetryableOllamaRegistryError(message: string) {
  const normalized = String(message || '').toLocaleLowerCase();
  return /(?:manifest|registry|ollama\.com)/.test(normalized)
    && /(?:\b401\b|\b408\b|\b425\b|\b429\b|\b5\d\d\b|unauthori[sz]ed|timeout|temporar|connection|eof)/.test(normalized);
}

export function friendlyOllamaPullError(model: string, message: string, language: UiLanguage = 'nl') {
  if (/\b401\b|unauthori[sz]ed/i.test(message)) {
    return localizedText(
      language,
      `Ollama Registry weigerde het publieke model ${model} (401). Hiervoor is geen Ollama API-key nodig. Controleer internettoegang en de Windows-datum/tijd, herstart Ollama en probeer opnieuw. Externe melding: ${message}`,
      `Ollama Registry rejected the public model ${model} (401). No Ollama API key is required. Check internet access and the Windows date/time, restart Ollama, then try again. External detail: ${message}`,
    );
  }
  return message || localizedText(language, `Ollama-model ${model} kon niet worden gedownload.`, `Ollama model ${model} could not be downloaded.`);
}

function waitForOllamaPullRetry(milliseconds: number, signal: AbortSignal, language: UiLanguage = 'nl') {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason || new Error(localizedText(language, 'Ollama-download geannuleerd.', 'Ollama download cancelled.')));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason || new Error(localizedText(language, 'Ollama-download geannuleerd.', 'Ollama download cancelled.')));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function deleteOllamaModel(
  baseUrl: string,
  requestedModel: unknown,
  fetchImpl: FetchLike = fetch,
  language: UiLanguage = 'nl',
) {
  const model = assertOllamaModelName(requestedModel, language);
  const response = await fetchImpl(`${trimBaseUrl(baseUrl)}/api/delete`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({ model }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(body || localizedText(language, `Ollama-model verwijderen mislukt (${response.status}).`, `Removing the Ollama model failed (${response.status}).`));
  }
  return model;
}

export function parseOllamaLibrarySearchHtml(html: string): OllamaLibraryModel[] {
  const results: OllamaLibraryModel[] = [];
  const seen = new Set<string>();
  for (const listItem of html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
    const block = listItem[1];
    const anchor = block.match(/<a\s+href="([^"]+)"[^>]*class="[^"]*\bgroup\b[^"]*\bw-full\b[^"]*"[^>]*>/i);
    const heading = block.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i);
    if (!anchor || !heading) continue;
    const name = cleanHtmlText(heading[1]);
    if (!name || seen.has(name.toLocaleLowerCase())) continue;
    const libraryPath = safeLibraryPath(anchor[1]);
    if (!libraryPath) continue;

    const description = cleanHtmlText(
      block.match(/<p\b[^>]*class="[^"]*\bmax-w-lg\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i)?.[1] || '',
    );
    const badges = Array.from(block.matchAll(
      /<span\b[^>]*class="[^"]*(?:bg-indigo-50|bg-\[#ddf4ff\])[^"]*"[^>]*>([\s\S]*?)<\/span>/gi,
    )).map((match) => cleanHtmlText(match[1])).filter(Boolean);
    const capabilities = badges.filter((badge) => LIBRARY_CAPABILITIES.has(badge.toLocaleLowerCase()));
    const variants = badges.filter((badge) => !LIBRARY_CAPABILITIES.has(badge.toLocaleLowerCase()));
    const plain = cleanHtmlText(block);
    results.push({
      name,
      description,
      libraryPath,
      capabilities,
      variants,
      pulls: plain.match(/([\d.,]+\s*[KMB]?)\s+Pulls?\b/i)?.[1]?.replace(/\s+/g, ''),
      tagCount: plain.match(/([\d.,]+\s*[KMB]?)\s+Tags?\b/i)?.[1]?.replace(/\s+/g, ''),
      updated: plain.match(/\bUpdated\s+(.+?)(?=\s{2,}|$)/i)?.[1],
    });
    seen.add(name.toLocaleLowerCase());
    if (results.length >= 30) break;
  }
  return results;
}

export function parseOllamaLibraryTagsHtml(html: string): OllamaLibraryTag[] {
  const results: OllamaLibraryTag[] = [];
  const seen = new Set<string>();
  const matches = Array.from(html.matchAll(
    /<a\s+href="([^"]+)"\s+class="group-hover:underline">([\s\S]*?)<\/a>/gi,
  ));
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const name = cleanHtmlText(match[2]);
    if (!name || seen.has(name.toLocaleLowerCase())) continue;
    try {
      assertOllamaModelName(name);
    } catch {
      continue;
    }
    const nextIndex = matches[index + 1]?.index ?? html.length;
    const snippet = html.slice(match.index, Math.min(nextIndex, match.index + 4_000));
    const columns = Array.from(snippet.matchAll(
      /<p\b[^>]*class="[^"]*\bcol-span-2\b[^"]*"[^>]*>([\s\S]*?)<\/p>/gi,
    )).map((column) => cleanHtmlText(column[1]));
    const input = cleanHtmlText(
      snippet.match(/<div\b[^>]*class="[^"]*\bcol-span-2\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1] || '',
    );
    const digestAndAge = snippet.match(
      /<span\b[^>]*class="[^"]*\bfont-mono\b[^"]*"[^>]*>([^<]+)<\/span>[\s\S]*?·(?:&nbsp;|\s)*([^<]+)<\/div>/i,
    );
    const colon = name.lastIndexOf(':');
    results.push({
      name,
      tag: colon >= 0 ? name.slice(colon + 1) : 'latest',
      sizeLabel: columns[0] || undefined,
      contextLabel: columns[1] || undefined,
      inputLabel: input || undefined,
      digest: cleanHtmlText(digestAndAge?.[1] || '') || undefined,
      updated: cleanHtmlText(digestAndAge?.[2] || '') || undefined,
    });
    seen.add(name.toLocaleLowerCase());
    if (results.length >= 100) break;
  }
  return results;
}

function officialLibraryTagsUrl(libraryPath: string, language: UiLanguage = 'nl') {
  const safePath = safeLibraryPath(libraryPath);
  if (!safePath) throw new Error(localizedText(language, 'Ongeldig pad naar de Ollama-modelbibliotheek.', 'Invalid Ollama model library path.'));
  const url = new URL(safePath.replace(/\/+$/, '') + '/tags', OLLAMA_LIBRARY_ORIGIN);
  if (url.origin !== OLLAMA_LIBRARY_ORIGIN) {
    throw new Error(localizedText(language, 'Ongeldige Ollama-modelbibliotheek.', 'Invalid Ollama model library.'));
  }
  return url;
}

async function fetchOfficialLibraryHtml(url: URL, fetchImpl: FetchLike, language: UiLanguage = 'nl') {
  const response = await fetchImpl(url, {
    headers: {
      Accept: 'text/html',
      'User-Agent': 'LLMelt/1.0',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(localizedText(
      language,
      `Ollama-modelbibliotheek reageerde met ${response.status}.`,
      `Ollama model library responded with ${response.status}.`,
    ));
  }
  if (new URL(response.url || url.toString()).origin !== OLLAMA_LIBRARY_ORIGIN) {
    throw new Error(localizedText(
      language,
      'De Ollama-modelbibliotheek stuurde door naar een onverwacht domein.',
      'The Ollama model library redirected to an unexpected domain.',
    ));
  }
  return readBoundedText(response, MAX_LIBRARY_RESPONSE_BYTES, language);
}

async function readBoundedText(response: Response, maximumBytes: number, language: UiLanguage = 'nl') {
  if (!response.body) return response.text();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value?.byteLength || 0;
    if (bytes > maximumBytes) {
      throw new Error(localizedText(
        language,
        'Ollama-modelbibliotheek gaf een te groot antwoord.',
        'The Ollama model library returned an oversized response.',
      ));
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

async function readOllamaTags(baseUrl: string, fetchImpl: FetchLike, language: UiLanguage = 'nl') {
  const response = await fetchImpl(`${trimBaseUrl(baseUrl)}/api/tags`, {
    signal: AbortSignal.timeout(7_500),
  });
  if (!response.ok) {
    throw new Error(localizedText(language, `Ollama reageerde met ${response.status}.`, `Ollama responded with ${response.status}.`));
  }
  const data = await response.json() as { models?: unknown };
  return Array.isArray(data.models) ? data.models as OllamaTagRecord[] : [];
}

async function ollamaModelExists(baseUrl: string, model: string, fetchImpl: FetchLike, language: UiLanguage = 'nl') {
  const normalized = model.toLocaleLowerCase();
  const models = await readOllamaTags(baseUrl, fetchImpl, language);
  return models.some((candidate) => ollamaTagName(candidate)?.toLocaleLowerCase() === normalized);
}

function ollamaTagName(model: OllamaTagRecord) {
  return stringValue(model.name) || stringValue(model.model);
}

function parseOllamaPullLine(line: string): {
  status?: unknown;
  completed?: unknown;
  total?: unknown;
  error?: unknown;
} | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function ollamaPullPhase(status: string): OllamaModelPullProgress['phase'] {
  const normalized = status.toLocaleLowerCase();
  if (normalized === 'success') return 'success';
  if (normalized.includes('verifying')) return 'verifying';
  if (normalized.includes('writing') || normalized.includes('removing')) return 'writing';
  if (normalized.includes('pulling')) return 'downloading';
  return 'resolving';
}

function ollamaPullStatus(status: string, model: string, language: UiLanguage = 'nl') {
  const normalized = status.toLocaleLowerCase();
  if (!normalized) return localizedText(language, `${model} voorbereiden...`, `Preparing ${model}...`);
  if (normalized === 'success') return localizedText(language, `${model} is gedownload.`, `${model} has been downloaded.`);
  if (normalized.includes('manifest')) {
    return normalized.includes('writing')
      ? localizedText(language, 'Modelinformatie opslaan...', 'Saving model information...')
      : localizedText(language, 'Modelinformatie ophalen...', 'Fetching model information...');
  }
  if (normalized.includes('verifying')) return localizedText(language, 'Download controleren...', 'Verifying download...');
  if (normalized.includes('removing')) return localizedText(language, 'Ongebruikte modelbestanden opruimen...', 'Cleaning up unused model files...');
  if (normalized.includes('pulling')) return localizedText(language, `${model} downloaden...`, `Downloading ${model}...`);
  return localizedText(language, `${model} voorbereiden...`, `Preparing ${model}...`);
}

function ollamaContextWindow(show: Record<string, unknown>) {
  const modelInfo = objectValue(show.model_info);
  for (const [key, value] of Object.entries(modelInfo)) {
    const numeric = Number(value);
    if (/context_length$/i.test(key) && Number.isFinite(numeric) && numeric > 0) return numeric;
  }
  for (const line of String(show.parameters || '').split(/\r?\n/)) {
    const match = line.trim().match(/^num_ctx\s+(\d+)/i);
    if (match) return Number(match[1]);
  }
  return undefined;
}

function safeLibraryPath(value: string) {
  try {
    const decoded = decodeURIComponent(value);
    if (!/^\/(?:library\/)?[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)?$/.test(decoded)) {
      return '';
    }
    return decoded;
  } catch {
    return '';
  }
}

function cleanHtmlText(value: string) {
  return decodeHtmlEntities(value.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function decodeHtmlEntities(value: string) {
  const named: Record<string, string> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
  };
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_full, entity: string) => {
    if (entity[0] === '#') {
      const hex = entity[1]?.toLocaleLowerCase() === 'x';
      const codePoint = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : '';
    }
    return named[entity.toLocaleLowerCase()] ?? '';
  });
}

function trimBaseUrl(value: string) {
  return String(value || 'http://localhost:11434').replace(/\/+$/, '');
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function finiteNumber(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : 0;
}

function positiveNumber(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : undefined;
}
