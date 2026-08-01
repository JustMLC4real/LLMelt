// Pure, testbare classificatie van een ChatGPT-paginastatus voor de web-engine.
//
// De scraper drijft een verborgen BrowserWindow aan. Soms verschijnt de composer niet.
// Dat heeft GRONDIG VERSCHILLENDE oorzaken die we niet door elkaar mogen halen:
//   - een lege/gecrashte render (transient → vers venster + opnieuw proberen heeft zin)
//   - een echte 403 "unusual activity" anti-bot blokkade (NIET legitiem te omzeilen →
//     eerlijk melden, niet blijven hameren; gebruiker logt evt. opnieuw in)
//   - een Cloudflare-verificatie of login-muur (gebruiker moet ingrijpen)
//
// Deze module bevat GEEN detectie-omzeiling. Het classificeert alleen wat er aan de hand is
// zodat de scraper transiente fouten herstelt en echte blokkades eerlijk terugmeldt.

export type ChatGptPageKind =
  | 'ready'
  | 'blocked'
  | 'cloudflare'
  | 'login'
  | 'crashed'
  | 'blank'
  | 'headers'
  | 'unknown';

export type ChatGptPageInput = {
  /** Main-frame HTTP-status indien bekend (0/undefined = onbekend). */
  httpStatus?: number;
  url?: string;
  title?: string;
  bodyText?: string;
  /** Is de composer (invoerveld) aanwezig in de DOM? */
  hasComposer?: boolean;
  /** Is het renderer-proces gecrasht (render-process-gone)? */
  renderGone?: boolean;
};

export type ChatGptPageVerdict = {
  kind: ChatGptPageKind;
  /** Venster opnieuw aanmaken + opnieuw proberen heeft zin. */
  retryable: boolean;
  /** Gebruiker kan via "ChatGPT herstellen" opnieuw inloggen / ingrijpen. */
  recoverable: boolean;
  /** Eerlijke NL-melding voor de gebruiker. */
  message: string;
};

const BLOCKED_RE = /unusual activity|try again later|access denied|too many requests/i;
const CLOUDFLARE_RE = /just a moment|verify you are human|cf-|attention required|checking your browser/i;
const LOGIN_RE = /\blog ?in\b|sign up|inloggen|welcome back|create account/i;

/**
 * Bepaal wat er met de ChatGPT-pagina aan de hand is. De volgorde is bewust:
 * eerst "klaar", dan transiente crash/blanco, dan de echte blokkades.
 */
export function classifyChatGptPage(input: ChatGptPageInput): ChatGptPageVerdict {
  const status = input.httpStatus ?? 0;
  const title = (input.title || '').trim();
  const body = (input.bodyText || '').trim();
  const url = input.url || '';

  // 1. Composer aanwezig → klaar om te typen.
  if (input.hasComposer) {
    return { kind: 'ready', retryable: false, recoverable: false, message: '' };
  }

  // 2a. Renderer gecrasht → transient, vers venster lost dit op.
  if (input.renderGone) {
    return {
      kind: 'crashed',
      retryable: true,
      recoverable: false,
      message: 'ChatGPT render-proces crashte; opnieuw proberen met een vers venster.',
    };
  }

  // 2b. HTTP 431 "Request Header Fields Too Large" — de cookie-jar is te groot
  //     geworden (Cloudflare/analytics-cookies stapelen op). De pagina laadt blanco.
  //     Retryable NA het opschonen van niet-essentiële cookies (doet de scraper).
  if (status === 431) {
    return {
      kind: 'headers',
      retryable: true,
      recoverable: false,
      message: 'ChatGPT-cookies te groot (HTTP 431); cookies opschonen en opnieuw proberen.',
    };
  }

  // 3. Echte anti-bot blokkade. Dit is GROUND TRUTH (403) of expliciete tekst.
  //    Niet legitiem te omzeilen → niet blijven hameren, eerlijk melden.
  if (status === 403 || status === 429 || BLOCKED_RE.test(body) || BLOCKED_RE.test(title)) {
    return {
      kind: 'blocked',
      retryable: false,
      recoverable: true,
      message: 'ChatGPT blokkeert deze geautomatiseerde web-engine wegens unusual activity.',
    };
  }

  // 4. Cloudflare-verificatie.
  if (CLOUDFLARE_RE.test(body) || CLOUDFLARE_RE.test(title)) {
    return {
      kind: 'cloudflare',
      retryable: false,
      recoverable: true,
      message: 'ChatGPT verificatie (Cloudflare) blokkeert de composer; open "ChatGPT herstellen".',
    };
  }

  // 5. Login-muur (sessie verlopen / uitgelogd).
  if ((LOGIN_RE.test(body) || /\/auth|\/login/i.test(url)) && !input.hasComposer) {
    return {
      kind: 'login',
      retryable: false,
      recoverable: true,
      message: 'ChatGPT web-sessie is niet (meer) ingelogd; open "ChatGPT herstellen" en log opnieuw in.',
    };
  }

  // 2b. Lege pagina zonder 403/CF/login en met een geslaagde of onbekende status →
  //     mislukte/afgebroken render. Transient: opnieuw laden met een vers venster.
  if ((status === 200 || status === 0) && !title && !body) {
    return {
      kind: 'blank',
      retryable: true,
      recoverable: false,
      message: 'ChatGPT pagina laadde leeg; opnieuw proberen met een vers venster.',
    };
  }

  // 6. Overig: DOM veranderd of onbekende toestand. Eén extra poging is veilig.
  return {
    kind: 'unknown',
    retryable: true,
    recoverable: true,
    message: `ChatGPT composer niet gevonden${url ? ` op ${url}` : ''}.`,
  };
}
