import { describe, expect, it } from 'vitest';
import {
  redactChatGptDiagnosticText,
  redactChatGptDiagnosticValue,
} from '../electron/chatgpt-diagnostic-redaction';

describe('ChatGPT-diagnostiekprivacy', () => {
  it('verwijdert bearer/JWT/querytokens en gesprek-id’s uit tekst', () => {
    const uuid = '6a687a67-4fec-83ed-abec-bac21eb68450';
    const jwt = 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.signature123';
    const result = redactChatGptDiagnosticText(
      `Bearer secret-token ${jwt} /conversation/${uuid}?token=abc123`,
    );

    expect(result).not.toContain('secret-token');
    expect(result).not.toContain(jwt);
    expect(result).not.toContain(uuid);
    expect(result).not.toContain('abc123');
    expect(result).toContain('[REDACTED');
  });

  it('redigeert gevoelige objectvelden recursief', () => {
    expect(redactChatGptDiagnosticValue({
      accountId: 'account-secret',
      nested: {
        conversation_id: 'conversation-secret',
        cookie: 'cookie-secret',
        status: 'ok',
      },
    })).toEqual({
      accountId: '[REDACTED]',
      nested: {
        conversation_id: '[REDACTED]',
        cookie: '[REDACTED]',
        status: 'ok',
      },
    });
  });
});
