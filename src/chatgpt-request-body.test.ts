import { describe, expect, it } from 'vitest';
import { patchChatGptConversationBody } from '../electron/chatgpt-request-body';

describe('ChatGPT web-requestkeuze', () => {
  it('overschrijft een koude SPA-standaard met het gekozen live model en niveau', () => {
    const patched = patchChatGptConversationBody(
      JSON.stringify({ model: 'gpt-5-3', messages: [{ role: 'user', content: 'Hallo' }], sentinel: 'websiteveld' }),
      'gpt-5-6-thinking',
      'extended',
    );
    expect(JSON.parse(String(patched))).toEqual({
      model: 'gpt-5-6-thinking',
      thinking_effort: 'extended',
      messages: [{ role: 'user', content: 'Hallo' }],
      sentinel: 'websiteveld',
    });
  });

  it('laat onleesbare of onvolledige requestlichamen ongemoeid', () => {
    expect(patchChatGptConversationBody('geen json', 'gpt-5-6-thinking', 'extended')).toBe('geen json');
    expect(patchChatGptConversationBody('{"model":"gpt-5-3"}', '', 'extended')).toBe('{"model":"gpt-5-3"}');
  });

  it('blijft als zelfstandige functie in de geïsoleerde webpagina uitvoerbaar', () => {
    const injected = Function(`return (${patchChatGptConversationBody.toString()})`)() as typeof patchChatGptConversationBody;
    const patched = injected('{"model":"gpt-5-3"}', 'gpt-5-6-thinking', 'standard');
    expect(JSON.parse(String(patched))).toMatchObject({
      model: 'gpt-5-6-thinking',
      thinking_effort: 'standard',
    });
  });
});
