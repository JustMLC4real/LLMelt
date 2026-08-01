import { describe, expect, it } from 'vitest';
import {
  isGeneratedTitleDistinct,
  isLikelyLegacyPromptTitle,
  isUsableGeneratedChatTitle,
  resolveConfiguredChatTitleMode,
  sanitizeGeneratedChatTitle,
  simpleChatTitleFrom,
} from '../electron/chat-title-mode';

describe('automatische gesprekstitels', () => {
  it('gebruikt voor AI-titels uitsluitend Ollama', () => {
    expect(resolveConfiguredChatTitleMode('ollama')).toBe('ollama');
    expect(resolveConfiguredChatTitleMode('auto')).toBe('ollama');
    expect(resolveConfiguredChatTitleMode('gpt')).toBe('ollama');
    expect(resolveConfiguredChatTitleMode(undefined)).toBe('ollama');
  });

  it('respecteert de niet-AI- en uitgeschakelde modi', () => {
    expect(resolveConfiguredChatTitleMode('simple')).toBe('simple');
    expect(resolveConfiguredChatTitleMode('off')).toBe('off');
  });

  it('weigert een AI-uitvoer die feitelijk dezelfde prompt als titel teruggeeft', () => {
    expect(isGeneratedTitleDistinct('Leg uit wat is eMacintosh.', 'leg uit wat is emacintosh')).toBe(false);
    expect(isGeneratedTitleDistinct('De geschiedenis van eMacintosh', 'leg uit wat is emacintosh')).toBe(true);
  });

  it('herkent ook de oude lokale 42-teken-fallback als herstelbare prompttitel', () => {
    const prompt = 'Maak een uitvoerige vergelijking tussen twee verschillende systemen';
    expect(simpleChatTitleFrom(prompt)).toBe('Maak een uitvoerige vergelijking tussen tw…');
    expect(isLikelyLegacyPromptTitle(simpleChatTitleFrom(prompt), prompt)).toBe(true);
    expect(isLikelyLegacyPromptTitle('Vergelijking van twee systemen', prompt)).toBe(false);
  });

  it('verwijdert modelvoorvoegsels en thinking zonder de echte titel te verliezen', () => {
    expect(sanitizeGeneratedChatTitle('Korte titel: Reden achter zwarte paarden.'))
      .toBe('Reden achter zwarte paarden');
    expect(sanitizeGeneratedChatTitle('<think>intern redeneren</think> Gesprekstitel: Macintosh uitgelegd'))
      .toBe('Macintosh uitgelegd');
  });

  it('weigert gekopieerde vragen en corrupte modelprefixen als titel', () => {
    expect(isUsableGeneratedChatTitle('Waarom zijn paarden zwart?', 'waarom zijn paarden zwart'))
      .toBe(false);
    expect(isUsableGeneratedChatTitle('/naar verklaring van zwarte paarden', 'waarom zijn paarden zwart'))
      .toBe(false);
    expect(isUsableGeneratedChatTitle('Gesprek over zwart paard', 'waarom zijn paarden zwart'))
      .toBe(true);
  });
});
