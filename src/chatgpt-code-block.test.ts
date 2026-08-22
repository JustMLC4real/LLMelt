import { describe, expect, it } from 'vitest';
import { cleanChatGptCodeBlockText } from './providers/chatgpt-code-block';

describe('ChatGPT-codeblokextractie', () => {
  it('verwijdert meegeschraapte Nederlandse codeblokbediening', () => {
    expect(cleanChatGptCodeBlockText('Python\nUitvoeren\ndef main():\n    print("hoi")', 'python'))
      .toBe('def main():\n    print("hoi")');
  });

  it('verwijdert meegeschraapte Engelse codeblokbediening', () => {
    expect(cleanChatGptCodeBlockText('python\nCopy code\nprint("hi")'))
      .toBe('print("hi")');
  });

  it('behoudt een gewone eerste broncoderegel met een taalnaam', () => {
    expect(cleanChatGptCodeBlockText('Python = "taal"\nprint(Python)', 'python'))
      .toBe('Python = "taal"\nprint(Python)');
  });

  it('behoudt zonder websitebediening ook witruimte en regeleinden exact', () => {
    const source = '\r\nprint("hi")\r\n';
    expect(cleanChatGptCodeBlockText(source, 'python')).toBe(source);
  });

  it('behoudt inspringing en lege regels in de broncode', () => {
    expect(cleanChatGptCodeBlockText('Python\nRun\n\ndef main():\n    print("hi")\n'))
      .toBe('\ndef main():\n    print("hi")\n');
  });

  it('verwijdert het gedeeltelijke sluitfence-fragment uit Python DOM-code', () => {
    expect(cleanChatGptCodeBlockText('print("ok")\n``', 'python')).toBe('print("ok")');
  });

  it('laat een geldig leeg JavaScript-template literal ongemoeid', () => {
    const source = 'const empty = ``;\nconsole.log(empty);';
    expect(cleanChatGptCodeBlockText(source, 'javascript')).toBe(source);
  });
});
