import { describe, expect, it } from 'vitest';
import { geminiQuotaOAuthCallbackHtml } from '../electron/gemini-quota-auth';

describe('Gemini quota OAuth-callback', () => {
  it('lokaliseert succes en herstel zonder providerinformatie te verliezen', () => {
    expect(geminiQuotaOAuthCallbackHtml(true, 'nl')).toContain('Google Cloud is gekoppeld');
    expect(geminiQuotaOAuthCallbackHtml(true, 'en')).toContain('Google Cloud is connected');
    expect(geminiQuotaOAuthCallbackHtml(false, 'nl')).toContain('Koppelen mislukt');
    expect(geminiQuotaOAuthCallbackHtml(false, 'en')).toContain('Connection failed');
  });
});
