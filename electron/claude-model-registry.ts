/**
 * Claude Code bundelt een `Hand-maintained baked-in model catalog` in zijn
 * binary: de eigen bron van waarheid voor context windows, output-limieten en
 * per-model capabilities. De Agent SDK publiceert via `supportedModels()` maar
 * een handvol daarvan (de aliassen die in het hoofdmenu staan), terwijl de CLI
 * de overige ids wel degelijk accepteert op `--model`.
 *
 * Deze module leest die catalogus uit de geïnstalleerde binary, zodat de app
 * dezelfde modellen en dezelfde cijfers toont als de CLI die er echt staat —
 * zonder ook maar één modelnaam of contextgrootte in onze eigen code te zetten.
 */

/** Eén model uit Claude Code's ingebakken catalogus. */
export interface ClaudeRegistryModel {
  id: string;
  family: string;
  displayName: string;
  /** De volledige, gedateerde id die de CLI naar de provider stuurt. */
  firstPartyId?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  capabilities: string[];
}

/** Het anker waarop we de catalogus in de bundle herkennen. */
const CATALOG_ANCHOR = 'models:[{id:"claude-';

/**
 * De catalogus is ~15 KB; een ruim venster vangt toekomstige groei op zonder
 * dat we ooit meer dan een fractie van de binary door de parser halen.
 */
const CATALOG_WINDOW_BYTES = 1024 * 1024;

/** Zonder dit minimum beschouwen we een treffer als een toevallige match. */
const MIN_PLAUSIBLE_MODELS = 3;

export function catalogAnchor() {
  return CATALOG_ANCHOR;
}

export function catalogWindowBytes() {
  return CATALOG_WINDOW_BYTES;
}

/**
 * Leest de `models:[...]`-array die op `anchorIndex` begint. Geeft een lege
 * lijst zodra er iets niet klopt: een gewijzigde bundle mag nooit meer doen dan
 * de extra modellen laten wegvallen.
 */
export function parseClaudeModelCatalog(text: string, anchorIndex?: number): ClaudeRegistryModel[] {
  const anchor = anchorIndex ?? text.indexOf(CATALOG_ANCHOR);
  if (anchor < 0) return [];

  const arrayStart = text.indexOf('[', anchor);
  if (arrayStart < 0) return [];

  let parsed: unknown;
  try {
    parsed = parseJsLiteral(text, arrayStart);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const models = parsed.flatMap((entry) => {
    const model = toRegistryModel(entry);
    return model ? [model] : [];
  });
  return models.length >= MIN_PLAUSIBLE_MODELS ? models : [];
}

function toRegistryModel(entry: unknown): ClaudeRegistryModel | undefined {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
  const record = entry as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  const family = typeof record.family === 'string' ? record.family.trim() : '';
  const displayName = typeof record.display_name === 'string' ? record.display_name.trim() : '';
  if (!id || !family || !displayName) return undefined;

  const providerIds = asRecord(record.provider_ids);
  const context = asRecord(record.context);
  const maxOutput = asRecord(record.max_output_tokens);

  return {
    id,
    family,
    displayName,
    firstPartyId: typeof providerIds?.first_party === 'string' ? providerIds.first_party : undefined,
    contextWindow: positiveNumber(context?.window),
    maxOutputTokens: positiveNumber(maxOutput?.default),
    capabilities: Array.isArray(record.capabilities)
      ? record.capabilities.filter((capability): capability is string => typeof capability === 'string')
      : [],
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function positiveNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * De effortniveaus die dit model volgens zijn eigen capabilities aankan. Claude
 * Code noemt alleen de uitbreidingen (`xhigh_effort`, `max_effort`) apart; de
 * basisdrie horen bij `effort` zelf.
 */
export function reasoningEffortsFromCapabilities(capabilities: string[]): string[] {
  if (!capabilities.includes('effort')) return [];
  const efforts = ['low', 'medium', 'high'];
  if (capabilities.includes('xhigh_effort')) efforts.push('xhigh');
  if (capabilities.includes('max_effort')) efforts.push('max');
  return efforts;
}

/**
 * Modellen die de CLI wél aankan maar niet in `supportedModels()` publiceert.
 * De effort-capability is het onderscheid dat Claude Code zelf hanteert tussen
 * de huidige generatie en uitgefaseerde modellen — daarmee valt een toekomstige
 * Opus vanzelf op zijn plek en blijven de oude 3.x/4.0-modellen weg.
 */
export function additionalRegistryModels(
  registry: ClaudeRegistryModel[],
  knownModelIds: string[],
): ClaudeRegistryModel[] {
  const known = new Set(knownModelIds.map(normalizeModelId).filter(Boolean));
  return registry
    .filter((model) => {
      if (!reasoningEffortsFromCapabilities(model.capabilities).length) return false;
      return !known.has(normalizeModelId(model.id))
        && !(model.firstPartyId && known.has(normalizeModelId(model.firstPartyId)));
    })
    // De catalogus loopt per familie van oud naar nieuw; omgekeerd staat het
    // nieuwste model bovenaan, zoals Claude Code het zelf ook toont.
    .reverse();
}

/**
 * Zoekt de catalogusregel die bij een SDK-model hoort. De SDK meldt soms de
 * gedateerde provider-id (`claude-haiku-4-5-20251001`) waar de catalogus de
 * korte id voert, en hangt contextvarianten als `[1m]` aan de waarde.
 */
export function findRegistryModel(
  registry: ClaudeRegistryModel[],
  ...candidateIds: (string | undefined)[]
): ClaudeRegistryModel | undefined {
  const wanted = candidateIds.map(normalizeModelId).filter(Boolean);
  if (!wanted.length) return undefined;

  return registry.find((model) => wanted.some((id) => id === normalizeModelId(model.id)
    || (model.firstPartyId && id === normalizeModelId(model.firstPartyId))));
}

function normalizeModelId(id: string | undefined) {
  return (id || '').trim().toLowerCase().replace(/\[[^\]]*\]$/, '');
}

/**
 * Een strikte lezer voor het JS-objectliteral zoals de bundler het achterlaat:
 * ongequote sleutels, `!0`/`!1` voor booleans en exponentnotatie. Alles wat
 * daarbuiten valt is een fout, zodat er nooit code uit de binary wordt
 * uitgevoerd en een onbekend formaat simpelweg niets oplevert.
 */
function parseJsLiteral(text: string, start: number): unknown {
  const cursor = { index: start };
  const value = readValue(text, cursor);
  return value;
}

function readValue(text: string, cursor: { index: number }): unknown {
  skipWhitespace(text, cursor);
  const char = text[cursor.index];

  if (char === '{') return readObject(text, cursor);
  if (char === '[') return readArray(text, cursor);
  if (char === '"' || char === "'") return readString(text, cursor);
  if (char === '!') return readNegatedNumber(text, cursor);
  if (char === '-' || (char >= '0' && char <= '9')) return readNumber(text, cursor);

  const word = text.slice(cursor.index, cursor.index + 5);
  if (word.startsWith('null')) { cursor.index += 4; return null; }
  if (word.startsWith('true')) { cursor.index += 4; return true; }
  if (word.startsWith('false')) { cursor.index += 5; return false; }

  throw new Error(`Onverwacht teken op ${cursor.index}`);
}

function readObject(text: string, cursor: { index: number }) {
  cursor.index += 1;
  const result: Record<string, unknown> = {};
  skipWhitespace(text, cursor);
  if (text[cursor.index] === '}') { cursor.index += 1; return result; }

  for (;;) {
    skipWhitespace(text, cursor);
    const key = text[cursor.index] === '"' || text[cursor.index] === "'"
      ? readString(text, cursor)
      : readIdentifier(text, cursor);
    skipWhitespace(text, cursor);
    if (text[cursor.index] !== ':') throw new Error(`Ontbrekende dubbele punt op ${cursor.index}`);
    cursor.index += 1;
    result[key] = readValue(text, cursor);
    skipWhitespace(text, cursor);

    const next = text[cursor.index];
    if (next === ',') { cursor.index += 1; skipWhitespace(text, cursor); if (text[cursor.index] === '}') { cursor.index += 1; return result; } continue; }
    if (next === '}') { cursor.index += 1; return result; }
    throw new Error(`Onverwacht teken in object op ${cursor.index}`);
  }
}

function readArray(text: string, cursor: { index: number }) {
  cursor.index += 1;
  const result: unknown[] = [];
  skipWhitespace(text, cursor);
  if (text[cursor.index] === ']') { cursor.index += 1; return result; }

  for (;;) {
    result.push(readValue(text, cursor));
    skipWhitespace(text, cursor);
    const next = text[cursor.index];
    if (next === ',') { cursor.index += 1; skipWhitespace(text, cursor); if (text[cursor.index] === ']') { cursor.index += 1; return result; } continue; }
    if (next === ']') { cursor.index += 1; return result; }
    throw new Error(`Onverwacht teken in array op ${cursor.index}`);
  }
}

function readString(text: string, cursor: { index: number }) {
  const quote = text[cursor.index];
  cursor.index += 1;
  let value = '';

  while (cursor.index < text.length) {
    const char = text[cursor.index];
    if (char === quote) { cursor.index += 1; return value; }
    if (char === '\\') {
      const escaped = text[cursor.index + 1];
      cursor.index += 2;
      if (escaped === 'u') {
        value += String.fromCharCode(Number.parseInt(text.slice(cursor.index, cursor.index + 4), 16));
        cursor.index += 4;
      } else {
        value += ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' } as Record<string, string>)[escaped] ?? escaped;
      }
      continue;
    }
    value += char;
    cursor.index += 1;
  }

  throw new Error('Niet-afgesloten string');
}

function readNumber(text: string, cursor: { index: number }) {
  const match = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(cursor.index));
  if (!match) throw new Error(`Ongeldig getal op ${cursor.index}`);
  cursor.index += match[0].length;
  return Number(match[0]);
}

/** De bundler schrijft `true`/`false` als `!0`/`!1`. */
function readNegatedNumber(text: string, cursor: { index: number }) {
  const digit = text[cursor.index + 1];
  if (digit !== '0' && digit !== '1') throw new Error(`Onbekende negatie op ${cursor.index}`);
  cursor.index += 2;
  return digit === '0';
}

function readIdentifier(text: string, cursor: { index: number }) {
  const match = /^[A-Za-z_$][\w$]*/.exec(text.slice(cursor.index));
  if (!match) throw new Error(`Ongeldige sleutel op ${cursor.index}`);
  cursor.index += match[0].length;
  return match[0];
}

function skipWhitespace(text: string, cursor: { index: number }) {
  while (cursor.index < text.length && /\s/.test(text[cursor.index])) cursor.index += 1;
}
