import { describe, expect, it } from 'vitest';
import {
  buildToolFailureRepairPrompt,
  buildToolRepairPrompt,
  buildToolSuccessSummaryPrompt,
  buildToolSyntaxRepairPrompt,
  compactToolSummaryForDisplay,
  shouldSkipCommandForFailedFileTool,
  validateFileToolPayload,
  validateModelCommand,
} from './agent-commands';

describe('verborgen toolprompts per UI-taal', () => {
  it('maakt de Engelse herstelprompts zonder Nederlandse hostlabels', () => {
    const result = { text: 'real output' };
    const failed = buildToolFailureRepairPrompt([result], 'en');
    const malformed = buildToolSyntaxRepairPrompt({ badReply: '<file-create', completedResults: [result] }, 'en');
    const missing = buildToolRepairPrompt({ userInput: 'Create a file', badReply: 'Done.' }, 'en');

    expect(failed).toContain('The previous LLMelt tool run');
    expect(failed).toContain('tool result 1');
    expect(failed).not.toContain('toolresultaat');
    expect(malformed).toContain('completed action 1');
    expect(malformed).not.toContain('afgeronde actie');
    expect(missing).toContain('Original user request');
    expect(missing).not.toContain('Oorspronkelijke gebruikersvraag');
  });

  it('maakt de Nederlandse prompts zonder Engelse hostlabels', () => {
    const result = { text: 'echte uitvoer' };
    const failed = buildToolFailureRepairPrompt([result], 'nl');
    const summary = buildToolSuccessSummaryPrompt([result], {}, 'nl');
    const malformed = buildToolSyntaxRepairPrompt({ badReply: '<file-create', completedResults: [result] }, 'nl');

    expect(failed).toContain('De vorige LLMelt tool-run');
    expect(failed).toContain('toolresultaat 1');
    expect(failed).not.toContain('tool result 1');
    expect(summary).toContain('Echte tool-output');
    expect(summary).toContain('toolresultaat 1');
    expect(malformed).toContain('afgeronde actie 1');
    expect(malformed).not.toContain('completed action');
  });

  it('lokaliseert validatie-, skip- en samenvattingsfeedback', () => {
    expect(shouldSkipCommandForFailedFileTool('python .\\broken.py', new Set(['broken.py']), 'en').message)
      .toContain('Command skipped because the file tool');
    expect(validateModelCommand('type > out.py', 'en').message).toContain('must not write files');
    expect(validateFileToolPayload({ type: 'file-create', path: 'x.py', content: '```python\nprint(1)\n```', overwrite: true }, 'en').message)
      .toContain('Markdown code fences');
    expect(compactToolSummaryForDisplay('x'.repeat(2_000), 40, 'en')).toContain('Summary shortened');
  });
});
