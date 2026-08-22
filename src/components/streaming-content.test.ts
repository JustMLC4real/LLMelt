import { describe, expect, it } from 'vitest';
import { visibleStreamingContent } from './streaming-content';

describe('zichtbare streamingtekst', () => {
  it('verbergt tijdelijke ChatGPT-webtoolsyntax en het bijbehorende codeblok', () => {
    expect(visibleStreamingContent({
      provider: 'openai',
      modelId: 'chatgpt:gpt-live',
      content: [
        'Ik voer de gevraagde toolstappen uit.',
        '<file-create path="simpel.py" source="next-fence"></file-create>',
        '```python',
        'print("Hallo")',
      ].join('\n'),
    })).toBe('');
  });

  it('verbergt de toolfase al zodra een openingstag binnenkomt', () => {
    expect(visibleStreamingContent({
      provider: 'openai',
      modelId: 'chatgpt:gpt-live',
      content: 'Ik ga het bestand maken.\n<file-cre',
    })).toBe('');
  });

  it('laat gewone ChatGPT-streamingtekst zichtbaar', () => {
    expect(visibleStreamingContent({
      provider: 'openai',
      modelId: 'chatgpt:gpt-live',
      content: 'Dit is een normaal antwoord dat nog wordt opgebouwd.',
    })).toBe('Dit is een normaal antwoord dat nog wordt opgebouwd.');
  });

  it('verandert OpenAI-API-streams niet', () => {
    const content = '<file-create path="voorbeeld.py">print(1)</file-create>';
    expect(visibleStreamingContent({
      provider: 'openai',
      modelId: 'gpt-api-live',
      content,
    })).toBe(content);
  });
});
