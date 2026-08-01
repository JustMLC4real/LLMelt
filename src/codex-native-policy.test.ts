import { describe, expect, it } from 'vitest';
import { codexApprovalRequest, codexPolicyFor } from '../electron/codex-native';

describe('Codex native approvalbeleid', () => {
  it('combineert auto-project met workspace-sandbox én untrusted approvals', () => {
    expect(codexPolicyFor('auto-project')).toEqual({ sandbox: 'workspace-write', approval: 'untrusted' });
  });

  it('houdt ask en full expliciet van elkaar gescheiden', () => {
    expect(codexPolicyFor('ask')).toEqual({ sandbox: 'danger-full-access', approval: 'untrusted' });
    expect(codexPolicyFor('full')).toEqual({ sandbox: 'danger-full-access', approval: 'never' });
  });

  it('neemt alle patchpaden uit het live Codex-elicitatiepayload over', () => {
    expect(codexApprovalRequest({
      codex_elicitation: 'patch-approval',
      codex_changes: {
        'C:\\project\\a.txt': { type: 'add', content: 'a' },
        'C:\\project\\b.txt': { type: 'modify', content: 'b' },
      },
    }, 'C:\\project')).toMatchObject({
      toolName: 'Write',
      input: {
        file_path: 'C:\\project\\a.txt',
        file_paths: ['C:\\project\\a.txt', 'C:\\project\\b.txt'],
      },
    });
  });

  it('toont het echte commando en cwd uit exec-approval', () => {
    expect(codexApprovalRequest({
      codex_elicitation: 'exec-approval',
      codex_command: ['powershell.exe', '-Command', 'Get-ChildItem'],
      codex_cwd: 'C:\\project',
    }, 'C:\\fallback')).toEqual({
      toolName: 'Bash',
      input: { command: 'powershell.exe -Command Get-ChildItem', cwd: 'C:\\project' },
    });
  });
});
