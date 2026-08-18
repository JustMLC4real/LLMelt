export interface StoredChatGptCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  expirationDate?: number;
  sameSite?: 'unspecified' | 'no_restriction' | 'lax' | 'strict';
}

export interface RestorableChatGptCookie extends StoredChatGptCookie {
  url: string;
}

export function chatGptCookieIdentity(cookie: Pick<StoredChatGptCookie, 'domain' | 'name' | 'path'>): string {
  return `${normalizeCookieDomain(cookie.domain)}\n${cookie.path || '/'}\n${cookie.name}`;
}

export function toRestorableChatGptCookie(
  cookie: StoredChatGptCookie,
  nowSeconds = Date.now() / 1000,
): RestorableChatGptCookie | null {
  const domain = normalizeCookieDomain(cookie.domain);
  if (!domain || (domain !== 'chatgpt.com' && !domain.endsWith('.chatgpt.com'))) return null;
  if (!cookie.name || typeof cookie.value !== 'string') return null;
  if (cookie.expirationDate && cookie.expirationDate <= nowSeconds) return null;

  const path = cookie.path?.startsWith('/') ? cookie.path : '/';
  return {
    url: `${cookie.secure === false ? 'http' : 'https'}://${domain}${path}`,
    name: cookie.name,
    value: cookie.value,
    ...(cookie.domain ? { domain: cookie.domain } : {}),
    path,
    secure: cookie.secure !== false,
    httpOnly: !!cookie.httpOnly,
    ...(cookie.expirationDate ? { expirationDate: cookie.expirationDate } : {}),
    ...(cookie.sameSite ? { sameSite: cookie.sameSite } : {}),
  };
}

function normalizeCookieDomain(domain: string | undefined): string {
  return String(domain || '').trim().replace(/^\./, '').toLowerCase();
}
