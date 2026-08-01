import crypto from 'crypto';
import http from 'http';
import { safeStorage, shell } from 'electron';
import { getCredential } from './credential-store';
import { getStore } from './settings-store';
import { parseGoogleMonitoringQuotas, parseGoogleServiceUsageQuotas } from './provider-quota';
import type { ProviderQuotaSnapshot } from '../src/providers/types';

const TOKEN_STORE_KEY = 'gemini.quota.oauthToken';
const PROJECT_KEY = 'gemini.quota.projectId';
const CLIENT_ID_KEY = 'gemini.quota.oauthClientId';
const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform.read-only',
  'https://www.googleapis.com/auth/monitoring.read',
];
const VALIDATION_CACHE_MS = 60_000;

let validationCache: { key: string; checkedAt: number; status: GeminiQuotaAuthStatus } | null = null;

type StoredGoogleToken = {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scope?: string;
};

export interface GeminiQuotaAuthStatus {
  connected: boolean;
  projectId?: string;
  oauthClientId?: string;
  clientIdConfigured: boolean;
  keyProjectMatches?: boolean;
  error?: string;
}

export async function configureGeminiQuota(projectId: string, oauthClientId: string) {
  const cleanProject = projectId.trim();
  const cleanClient = oauthClientId.trim();
  if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(cleanProject)) throw new Error('Geef een geldig Google Cloud-project-ID op.');
  if (!/\.apps\.googleusercontent\.com$/.test(cleanClient)) throw new Error('Geef een geldige Google OAuth desktop-client-ID op.');
  const store = await getStore();
  store.set(PROJECT_KEY, cleanProject);
  store.set(CLIENT_ID_KEY, cleanClient);
  invalidateGeminiQuotaValidation();
  return { projectId: cleanProject, oauthClientId: cleanClient };
}

export async function startGeminiQuotaOAuth(): Promise<GeminiQuotaAuthStatus> {
  const store = await getStore();
  const projectId = String(store.get(PROJECT_KEY) || '').trim();
  const clientId = String(store.get(CLIENT_ID_KEY) || process.env.GOOGLE_OAUTH_CLIENT_ID || '').trim();
  if (!projectId || !clientId) throw new Error('Stel eerst het Google Cloud-project en de OAuth desktop-client-ID in.');
  if (!(await getCredential('google')).value) throw new Error('Sla eerst de verplichte Gemini API-key op.');

  const verifier = base64Url(crypto.randomBytes(48));
  const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest());
  const state = base64Url(crypto.randomBytes(24));
  const { server, redirectUri, code } = await createOAuthCallbackServer(state);
  try {
    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', GOOGLE_SCOPES.join(' '));
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'consent');
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('state', state);
    await shell.openExternal(authUrl.toString());
    const authorizationCode = await code;
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        code: authorizationCode,
        code_verifier: verifier,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }),
    });
    const body = await response.json() as any;
    if (!response.ok || !body.access_token) throw new Error(body?.error_description || body?.error || `Google OAuth faalde (${response.status}).`);
    await saveToken({
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: Date.now() + Math.max(60, Number(body.expires_in || 3600)) * 1000,
      scope: body.scope,
    });
    invalidateGeminiQuotaValidation();
    return getGeminiQuotaAuthStatus(true);
  } finally {
    server.close();
  }
}

export async function disconnectGeminiQuotaOAuth() {
  const store = await getStore();
  store.delete(TOKEN_STORE_KEY);
  invalidateGeminiQuotaValidation();
  return getGeminiQuotaAuthStatus(false);
}

export function invalidateGeminiQuotaValidation() {
  validationCache = null;
}

export async function getGeminiQuotaAuthStatus(validate = false): Promise<GeminiQuotaAuthStatus> {
  const store = await getStore();
  const projectId = String(store.get(PROJECT_KEY) || '').trim() || undefined;
  const clientId = String(store.get(CLIENT_ID_KEY) || process.env.GOOGLE_OAUTH_CLIENT_ID || '').trim();
  const token = await readToken();
  const hasApiKey = Boolean((await getCredential('google')).value);
  if (!hasApiKey || !projectId || !clientId || !token) {
    return { connected: false, projectId, oauthClientId: clientId || undefined, clientIdConfigured: !!clientId, error: 'Gemini vereist een API-key én Google Cloud-quota-koppeling.' };
  }
  if (!hasRequiredGoogleScopes(token)) {
    return {
      connected: false,
      projectId,
      oauthClientId: clientId,
      clientIdConfigured: true,
      error: 'Koppel Google Cloud opnieuw: Service Usage en Cloud Monitoring zijn verplicht voor Gemini-quota.',
    };
  }
  if (!validate) return { connected: true, projectId, oauthClientId: clientId, clientIdConfigured: true };
  const validationKey = `${projectId}:${clientId}:${token.expiresAt}`;
  if (validationCache?.key === validationKey && Date.now() - validationCache.checkedAt < VALIDATION_CACHE_MS) {
    return validationCache.status;
  }
  try {
    const accessToken = await getValidAccessToken(token, clientId);
    const keyProjectMatches = await validateApiKeyProject(accessToken, projectId);
    if (!keyProjectMatches) {
      const status = { connected: false, projectId, oauthClientId: clientId, clientIdConfigured: true, keyProjectMatches: false, error: 'De Gemini API-key hoort niet bij het gekoppelde Google Cloud-project.' };
      validationCache = { key: validationKey, checkedAt: Date.now(), status };
      return status;
    }
    await validateQuotaReadAccess(accessToken, projectId);
    const status = { connected: true, projectId, oauthClientId: clientId, clientIdConfigured: true, keyProjectMatches: true };
    validationCache = { key: validationKey, checkedAt: Date.now(), status };
    return status;
  } catch (error) {
    const status = { connected: false, projectId, oauthClientId: clientId, clientIdConfigured: true, error: error instanceof Error ? error.message : String(error) };
    validationCache = { key: validationKey, checkedAt: Date.now(), status };
    return status;
  }
}

export async function collectGeminiQuotaSnapshots(): Promise<ProviderQuotaSnapshot[]> {
  const store = await getStore();
  const projectId = String(store.get(PROJECT_KEY) || '').trim();
  const clientId = String(store.get(CLIENT_ID_KEY) || process.env.GOOGLE_OAUTH_CLIENT_ID || '').trim();
  const token = await readToken();
  if (!projectId || !clientId || !token) throw new Error('Google Cloud-quota is nog niet gekoppeld.');
  if (!hasRequiredGoogleScopes(token)) throw new Error('Koppel Google Cloud opnieuw om de verplichte Monitoring-toegang toe te voegen.');
  const accessToken = await getValidAccessToken(token, clientId);
  if (!(await validateApiKeyProject(accessToken, projectId))) {
    throw new Error('De Gemini API-key en Google Cloud-quota horen niet bij hetzelfde project.');
  }

  const metrics = await fetchServiceUsageMetrics(accessToken, projectId);
  const serviceUsage = parseGoogleServiceUsageQuotas({ metrics }, projectId);
  const monitoring = await collectGoogleMonitoringSnapshots(accessToken, projectId);
  // Voor een nog ongebruikt project zijn er soms nog geen actieve Monitoring-
  // reeksen. Service Usage blijft dan de officiële limietbron.
  return monitoring.length ? monitoring : serviceUsage;
}

async function fetchServiceUsageMetrics(accessToken: string, projectId: string, pageSize = 200) {
  let pageToken = '';
  const metrics: any[] = [];
  do {
    const url = new URL(`https://serviceusage.googleapis.com/v1beta1/projects/${encodeURIComponent(projectId)}/services/generativelanguage.googleapis.com/consumerQuotaMetrics`);
    url.searchParams.set('view', 'FULL');
    url.searchParams.set('pageSize', String(pageSize));
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const body = await googleJson(url, accessToken, 'Google Service Usage');
    metrics.push(...(body.metrics || body.consumerQuotaMetrics || []));
    pageToken = String(body.nextPageToken || '');
  } while (pageToken);
  return metrics;
}

async function collectGoogleMonitoringSnapshots(accessToken: string, projectId: string) {
  const descriptorUrl = new URL(`https://monitoring.googleapis.com/v3/projects/${encodeURIComponent(projectId)}/metricDescriptors`);
  descriptorUrl.searchParams.set('filter', 'metric.type = starts_with("generativelanguage.googleapis.com/quota/")');
  descriptorUrl.searchParams.set('activeOnly', 'true');
  descriptorUrl.searchParams.set('pageSize', '500');
  const descriptorBody = await googleJson(descriptorUrl, accessToken, 'Google Cloud Monitoring');
  const descriptors = Array.isArray(descriptorBody.metricDescriptors) ? descriptorBody.metricDescriptors : [];
  const limitTypes = descriptors
    .map((descriptor: any) => String(descriptor?.type || ''))
    .filter((type: string) => type.endsWith('/limit'));
  if (!limitTypes.length) return [];
  const descriptorMap = new Map<string, any>(descriptors.map((descriptor: any) => [String(descriptor?.type || ''), descriptor]));
  for (const limitType of limitTypes) {
    const usageType = `${limitType.slice(0, -'/limit'.length)}/usage`;
    if (!descriptorMap.has(usageType)) descriptorMap.set(usageType, { type: usageType, metricKind: 'DELTA' });
  }
  const metricTypes: string[] = [...new Set<string>(limitTypes.flatMap((limitType: string) => [limitType, `${limitType.slice(0, -'/limit'.length)}/usage`]))];
  const timeSeries = (await mapWithConcurrency(metricTypes, 6, (metricType) => fetchGoogleTimeSeries(accessToken, projectId, metricType))).flat();
  return parseGoogleMonitoringQuotas({ metricDescriptors: [...descriptorMap.values()], timeSeries }, projectId);
}

async function fetchGoogleTimeSeries(accessToken: string, projectId: string, metricType: string) {
  const url = new URL(`https://monitoring.googleapis.com/v3/projects/${encodeURIComponent(projectId)}/timeSeries`);
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - 25 * 3600_000);
  url.searchParams.set('filter', `metric.type = "${metricType}"`);
  url.searchParams.set('interval.startTime', startTime.toISOString());
  url.searchParams.set('interval.endTime', endTime.toISOString());
  url.searchParams.set('view', 'FULL');
  url.searchParams.set('pageSize', '5000');
  const body = await googleJson(url, accessToken, 'Google Cloud Monitoring');
  return Array.isArray(body.timeSeries) ? body.timeSeries : [];
}

async function validateQuotaReadAccess(accessToken: string, projectId: string) {
  const serviceUrl = new URL(`https://serviceusage.googleapis.com/v1beta1/projects/${encodeURIComponent(projectId)}/services/generativelanguage.googleapis.com/consumerQuotaMetrics`);
  serviceUrl.searchParams.set('view', 'BASIC');
  serviceUrl.searchParams.set('pageSize', '1');
  await googleJson(serviceUrl, accessToken, 'Google Service Usage');
  const monitoringUrl = new URL(`https://monitoring.googleapis.com/v3/projects/${encodeURIComponent(projectId)}/metricDescriptors`);
  monitoringUrl.searchParams.set('filter', 'metric.type = starts_with("generativelanguage.googleapis.com/quota/")');
  monitoringUrl.searchParams.set('pageSize', '1');
  await googleJson(monitoringUrl, accessToken, 'Google Cloud Monitoring');
}

async function googleJson(url: URL, accessToken: string, label: string) {
  const response = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
  const body = await response.json() as any;
  if (!response.ok) throw new Error(body?.error?.message || `${label} faalde (${response.status}).`);
  return body;
}

async function mapWithConcurrency<T, R>(values: T[], concurrency: number, mapper: (value: T) => Promise<R>) {
  const result = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      result[index] = await mapper(values[index]);
    }
  }));
  return result;
}

async function validateApiKeyProject(accessToken: string, projectId: string) {
  const credential = await getCredential('google');
  if (!credential.value) throw new Error('Gemini API-key ontbreekt.');
  // lookupKey retourneert het numerieke project in plaats van de door de gebruiker
  // ingevoerde project-ID. Vraag daarom eerst de canonieke projectresource op en
  // vergelijk vervolgens dezelfde identifiers.
  const project = await googleJson(
    new URL(`https://cloudresourcemanager.googleapis.com/v3/projects/${encodeURIComponent(projectId)}`),
    accessToken,
    'Google Cloud-project controleren',
  );
  const canonicalProject = String(project?.name || '');
  const lookupUrl = new URL('https://apikeys.googleapis.com/v2/keys:lookupKey');
  lookupUrl.searchParams.set('keyString', credential.value);
  const key = await googleJson(lookupUrl, accessToken, 'API-keyproject controleren');
  const parent = String(key?.parent || '');
  return Boolean(canonicalProject) && (
    parent === canonicalProject
    || parent.startsWith(`${canonicalProject}/`)
  );
}

async function getValidAccessToken(token: StoredGoogleToken, clientId: string) {
  if (token.expiresAt > Date.now() + 60_000) return token.accessToken;
  if (!token.refreshToken) throw new Error('Google OAuth-sessie is verlopen; koppel Google Cloud opnieuw.');
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, refresh_token: token.refreshToken, grant_type: 'refresh_token' }),
  });
  const body = await response.json() as any;
  if (!response.ok || !body.access_token) throw new Error(body?.error_description || body?.error || 'Google OAuth vernieuwen faalde.');
  const refreshed = { ...token, accessToken: body.access_token, expiresAt: Date.now() + Number(body.expires_in || 3600) * 1000 };
  await saveToken(refreshed);
  return refreshed.accessToken;
}

function hasRequiredGoogleScopes(token: StoredGoogleToken) {
  const scopes = new Set(String(token.scope || '').split(/\s+/).filter(Boolean));
  return GOOGLE_SCOPES.every((scope) => scopes.has(scope));
}

async function saveToken(token: StoredGoogleToken) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows-beveiligde opslag is niet beschikbaar; OAuth-token is niet opgeslagen.');
  (await getStore()).set(TOKEN_STORE_KEY, safeStorage.encryptString(JSON.stringify(token)).toString('base64'));
}

async function readToken(): Promise<StoredGoogleToken | null> {
  const encrypted = String((await getStore()).get(TOKEN_STORE_KEY) || '');
  if (!encrypted || !safeStorage.isEncryptionAvailable()) return null;
  try {
    return JSON.parse(safeStorage.decryptString(Buffer.from(encrypted, 'base64'))) as StoredGoogleToken;
  } catch {
    return null;
  }
}

async function createOAuthCallbackServer(expectedState: string) {
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const code = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  const server = http.createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    const error = url.searchParams.get('error');
    const state = url.searchParams.get('state');
    const value = url.searchParams.get('code');
    response.writeHead(error || !value || state !== expectedState ? 400 : 200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(error || !value || state !== expectedState
      ? '<h1>Koppelen mislukt</h1><p>Ga terug naar LLMelt en probeer opnieuw.</p>'
      : '<h1>Google Cloud is gekoppeld</h1><p>Je kunt dit venster sluiten en teruggaan naar LLMelt.</p>');
    if (error || !value || state !== expectedState) rejectCode(new Error(error || 'Ongeldige OAuth-callback.'));
    else resolveCode(value);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Kon geen lokale OAuth-callback openen.');
  const timeout = setTimeout(() => rejectCode(new Error('Google OAuth-koppeling duurde te lang.')), 180_000);
  code.finally(() => clearTimeout(timeout)).catch(() => {});
  return { server, redirectUri: `http://127.0.0.1:${address.port}/oauth/google/callback`, code };
}

function base64Url(value: Buffer) {
  return value.toString('base64url');
}
