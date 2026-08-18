import { describe, expect, it } from 'vitest';
import {
  chatGptCookieIdentity,
  toRestorableChatGptCookie,
} from '../electron/chatgpt-session-cookies';

describe('ChatGPT-sessiecookies', () => {
  it('herstelt alleen geldige ChatGPT-cookies met een bruikbare URL', () => {
    expect(toRestorableChatGptCookie({
      name: '__Secure-next-auth.session-token',
      value: 'versleuteld-opgeslagen-waarde',
      domain: '.chatgpt.com',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
    }, 100)).toEqual({
      url: 'https://chatgpt.com/',
      name: '__Secure-next-auth.session-token',
      value: 'versleuteld-opgeslagen-waarde',
      domain: '.chatgpt.com',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
    });

    expect(toRestorableChatGptCookie({
      name: 'sid',
      value: 'waarde',
      domain: '.example.com',
    }, 100)).toBeNull();
    expect(toRestorableChatGptCookie({
      name: 'sid',
      value: 'waarde',
      domain: 'chatgpt.com',
      expirationDate: 99,
    }, 100)).toBeNull();
  });

  it('herkent dezelfde cookie onafhankelijk van een leidende domeinpunt', () => {
    expect(chatGptCookieIdentity({ domain: '.chatgpt.com', path: '/', name: 'sid' }))
      .toBe(chatGptCookieIdentity({ domain: 'chatgpt.com', path: '/', name: 'sid' }));
  });
});
