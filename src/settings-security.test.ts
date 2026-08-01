import { describe, expect, it } from 'vitest';
import {
  buildRendererSettingsSnapshot,
  sanitizeRendererSettingValue,
} from '../electron/settings-security';

describe('settings-security', () => {
  it('laat alleen expliciete rendererinstellingen door', () => {
    const values: Record<string, unknown> = {
      'profile.avatarDataUrl': 'data:image/png;base64,AA==',
      'ollama.url': 'http://localhost:11434',
      'claude.executable': '%USERPROFILE%\\.local\\bin\\claude.exe',
      sshConfig: { host: 'server', port: '22', user: 'justin', password: 'geheim', privateKey: 'geheim' },
      credentials: { google: 'geheim' },
      mcpOwnerTokenEncrypted: 'geheim',
    };
    const snapshot = buildRendererSettingsSnapshot((key) => values[key]);
    expect(snapshot.sshConfig).toEqual({ host: 'server', port: '22', user: 'justin' });
    expect(snapshot.claude.executable).toBe('%USERPROFILE%\\.local\\bin\\claude.exe');
    expect(JSON.stringify(snapshot)).not.toContain('geheim');
    expect(snapshot).not.toHaveProperty('credentials');
    expect(snapshot).not.toHaveProperty('mcpOwnerTokenEncrypted');
  });

  it('weigert niet-HTTP Ollama-URL’s', () => {
    expect(() => sanitizeRendererSettingValue('ollama.url', 'file:///C:/Windows/win.ini')).toThrow(/http/i);
  });

  it('begrenst timeout, modellen en avatarinhoud', () => {
    expect(sanitizeRendererSettingValue('codex.timeoutSeconds', 99999)).toBe(3600);
    expect(() => sanitizeRendererSettingValue('antigravity.models', Array(201).fill('model'))).toThrow(/ongeldig/i);
    expect(() => sanitizeRendererSettingValue('profile.avatarDataUrl', 'data:text/html;base64,AA==')).toThrow(/data-URL/i);
  });

  it('staat de expliciete titelmodi toe en weigert onbekende waarden', () => {
    expect(sanitizeRendererSettingValue('chat.autoTitleMode', 'ollama')).toBe('ollama');
    expect(sanitizeRendererSettingValue('chat.autoTitleMode', 'simple')).toBe('simple');
    expect(() => sanitizeRendererSettingValue('chat.autoTitleMode', 'gpt')).toThrow(/ongeldig/i);
    expect(() => sanitizeRendererSettingValue('chat.autoTitleMode', 'auto')).toThrow(/ongeldig/i);
    expect(() => sanitizeRendererSettingValue('chat.autoTitleMode', 'prompt-kopiëren')).toThrow(/ongeldig/i);
  });

  it('migreert oude GPT- en automatische titelinstellingen in de renderer naar Ollama', () => {
    for (const legacyMode of ['auto', 'gpt', undefined]) {
      const snapshot = buildRendererSettingsSnapshot((key) =>
        key === 'chat.autoTitleMode' ? legacyMode : undefined);
      expect(snapshot.chat.autoTitleMode).toBe('ollama');
    }
  });
});
