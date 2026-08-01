import { describe, expect, it } from 'vitest';
import { agentToolEnvironmentInstructions } from '../electron/agent-tool-instructions';

describe('agent tool command environment', () => {
  it('legt Windows PowerShell 5.1 zonder Bash-syntax uit', () => {
    const instructions = agentToolEnvironmentInstructions('powershell', 'win32');
    expect(instructions).toContain('Windows PowerShell 5.1');
    expect(instructions).toContain('&&');
    expect(instructions).toContain('/dev/null');
    expect(instructions).toContain('python3');
    expect(instructions).toContain('active project/workspace directory');
  });

  it('onderscheidt cmd en PowerShell 7 op basis van de echte instelling', () => {
    expect(agentToolEnvironmentInstructions('cmd', 'win32')).toContain('cmd.exe');
    expect(agentToolEnvironmentInstructions('cmd', 'win32')).not.toContain('PowerShell 5.1');
    expect(agentToolEnvironmentInstructions('pwsh', 'win32')).toContain('PowerShell 7');
  });
});
