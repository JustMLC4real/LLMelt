import { describe, expect, it } from 'vitest';
import { claudeCliModelsFromHelp } from '../electron/claude-cli-catalog';

describe('Claude CLI live catalogusparser', () => {
  it('leest alleen de waarden uit de --model-helpsectie en bewaart nieuwe namen', () => {
    const help = [
      '  --fallback-model <model>  Example claude-old-1',
      '  --model <model>           Provide an alias (e.g. \'nova\', \'sonnet\') or a full name',
      '                            (e.g. \'claude-nova-7-2\').',
      '  --name <name>             Session name',
    ].join('\n');

    expect(claudeCliModelsFromHelp(help)).toEqual([
      { id: 'nova', name: 'Nova' },
      { id: 'sonnet', name: 'Sonnet' },
      { id: 'claude-nova-7-2', name: 'Claude Nova 7 2' },
    ]);
  });

  it('dedupliceert en negeert placeholders', () => {
    const help = [
      '  --model <model>  aliases \'model\', \'latest\', \'future\', \'future\'',
      '  --name <name>    Session name',
    ].join('\n');

    expect(claudeCliModelsFromHelp(help)).toEqual([{ id: 'future', name: 'Future' }]);
  });
});
