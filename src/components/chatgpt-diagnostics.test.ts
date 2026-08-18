import { describe, expect, it } from 'vitest';
import { classifyChatGptPage } from './chatgpt-diagnostics';

describe('classifyChatGptPage', () => {
  it('reports ready when the composer is present', () => {
    const v = classifyChatGptPage({ hasComposer: true, httpStatus: 200, title: 'ChatGPT', bodyText: 'hi' });
    expect(v.kind).toBe('ready');
    expect(v.retryable).toBe(false);
  });

  it('treats a crashed renderer as a retryable transient', () => {
    const v = classifyChatGptPage({ renderGone: true });
    expect(v.kind).toBe('crashed');
    expect(v.retryable).toBe(true);
    expect(v.recoverable).toBe(false);
  });

  it('localiseert diagnostiek expliciet zonder de classificatie te veranderen', () => {
    const nl = classifyChatGptPage({ renderGone: true }, 'nl');
    const en = classifyChatGptPage({ renderGone: true }, 'en');

    expect(nl).toMatchObject({ kind: 'crashed', retryable: true });
    expect(en).toMatchObject({ kind: 'crashed', retryable: true });
    expect(nl.message).toContain('render-proces');
    expect(en.message).toContain('renderer crashed');
  });

  it('treats a blank 200 page (empty title+body) as retryable blank, not a block', () => {
    const v = classifyChatGptPage({ httpStatus: 200, title: '', bodyText: '', hasComposer: false });
    expect(v.kind).toBe('blank');
    expect(v.retryable).toBe(true);
    expect(v.recoverable).toBe(false);
  });

  it('treats unknown HTTP status with empty page as retryable blank', () => {
    const v = classifyChatGptPage({ httpStatus: 0, title: '', bodyText: '' });
    expect(v.kind).toBe('blank');
    expect(v.retryable).toBe(true);
  });

  it('classifies a 403 as a non-retryable, recoverable block', () => {
    const v = classifyChatGptPage({ httpStatus: 403, title: '', bodyText: '' });
    expect(v.kind).toBe('blocked');
    expect(v.retryable).toBe(false);
    expect(v.recoverable).toBe(true);
    expect(v.message).toMatch(/unusual activity/i);
  });

  it('classifies "unusual activity" body text as a block even on status 200', () => {
    const v = classifyChatGptPage({ httpStatus: 200, bodyText: 'We detected unusual activity. Try again later.' });
    expect(v.kind).toBe('blocked');
    expect(v.retryable).toBe(false);
  });

  it('classifies a 429 as a block', () => {
    expect(classifyChatGptPage({ httpStatus: 429, bodyText: '' }).kind).toBe('blocked');
  });

  it('classifies a 431 (headers/cookies too large) as a retryable headers problem', () => {
    const v = classifyChatGptPage({ httpStatus: 431, title: '', bodyText: '', hasComposer: false });
    expect(v.kind).toBe('headers');
    expect(v.retryable).toBe(true);
    expect(v.recoverable).toBe(false);
    expect(v.message).toMatch(/431|cookies/i);
  });

  it('detects a Cloudflare challenge', () => {
    const v = classifyChatGptPage({ httpStatus: 403, bodyText: 'Just a moment... verify you are human' });
    // 403 wins first (still a block) — but a pure CF page on 200 is cloudflare.
    expect(v.kind).toBe('blocked');
    const cf = classifyChatGptPage({ httpStatus: 200, bodyText: 'Just a moment... checking your browser' });
    expect(cf.kind).toBe('cloudflare');
    expect(cf.recoverable).toBe(true);
  });

  it('detects a login wall', () => {
    const v = classifyChatGptPage({ httpStatus: 200, bodyText: 'Welcome back, log in to continue', hasComposer: false });
    expect(v.kind).toBe('login');
    expect(v.recoverable).toBe(true);
  });

  it('detects a login wall from an /auth url', () => {
    const v = classifyChatGptPage({ httpStatus: 200, url: 'https://chatgpt.com/auth/login', bodyText: 'x' });
    expect(v.kind).toBe('login');
  });

  it('falls back to unknown (one extra retry) for a changed DOM with content', () => {
    const v = classifyChatGptPage({ httpStatus: 200, title: 'ChatGPT', bodyText: 'some unexpected layout', hasComposer: false });
    expect(v.kind).toBe('unknown');
    expect(v.retryable).toBe(true);
  });
});
