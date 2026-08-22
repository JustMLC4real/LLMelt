import { describe, expect, it } from 'vitest';
import { claudeCliModelsFromHelp, claudeCliModelsFromSupportedModels } from '../electron/claude-cli-catalog';

describe('Claude CLI live catalogusparser', () => {
  it('leest alleen de waarden uit de --model-helpsectie en bewaart nieuwe namen', () => {
    const help = [
      '  --fallback-model <model>  Example claude-old-1',
      '  --model <model>           Provide an alias (e.g. \'nova\', \'sonnet\') or a full name',
      '                            (e.g. \'claude-nova-7-2\').',
      '  --name <name>             Session name',
    ].join('\n');

    expect(claudeCliModelsFromHelp(help)).toEqual([
      { id: 'claude-nova-7-2', name: 'Nova 7.2' },
      { id: 'sonnet', name: 'Sonnet' },
    ]);
  });

  it('voegt geen CLI-label of verzonnen versie toe aan provideraliassen', () => {
    const help = [
      "  --model <model>  aliases 'fable', 'opus', 'sonnet'; full model 'claude-fable-5'",
      '  --name <name>    Session name',
    ].join('\n');

    expect(claudeCliModelsFromHelp(help)).toEqual([
      { id: 'claude-fable-5', name: 'Fable 5' },
      { id: 'opus', name: 'Opus' },
      { id: 'sonnet', name: 'Sonnet' },
    ]);
  });

  it('dedupliceert en negeert placeholders', () => {
    const help = [
      '  --model <model>  aliases \'model\', \'latest\', \'future\', \'future\'',
      '  --name <name>    Session name',
    ].join('\n');

    expect(claudeCliModelsFromHelp(help)).toEqual([{ id: 'future', name: 'Future' }]);
  });

  it('gebruikt de officiële live SDK-catalogus met versies en per-model effort', () => {
    expect(claudeCliModelsFromSupportedModels([
      {
        value: 'default',
        resolvedModel: 'claude-sonnet-5',
        displayName: 'Default (recommended)',
        description: 'Sonnet 5 · Best for everyday use',
      },
      {
        value: 'sonnet',
        resolvedModel: 'claude-sonnet-5',
        displayName: 'Sonnet',
        description: 'Sonnet 5 · Best for everyday use',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'medium', 'high'],
      },
      {
        value: 'opus',
        resolvedModel: 'claude-opus-5',
        displayName: 'Opus',
        description: 'Opus 5 · Most capable',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'high', 'max'],
      },
      {
        value: 'haiku',
        resolvedModel: 'claude-haiku-4-5-20251001',
        displayName: 'Haiku',
        description: 'Haiku 4.5 · Fastest',
      },
    ])).toEqual([
      {
        id: 'sonnet',
        name: 'Sonnet 5',
        resolvedModel: 'claude-sonnet-5',
        supportedReasoningEfforts: ['low', 'medium', 'high'],
      },
      {
        id: 'opus',
        name: 'Opus 5',
        resolvedModel: 'claude-opus-5',
        supportedReasoningEfforts: ['low', 'high', 'max'],
      },
      {
        id: 'haiku',
        name: 'Haiku 4.5',
        resolvedModel: 'claude-haiku-4-5-20251001',
        supportedReasoningEfforts: [],
      },
    ]);
  });
});
