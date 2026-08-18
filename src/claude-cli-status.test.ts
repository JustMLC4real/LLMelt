import { describe, expect, it } from 'vitest';
import { claudeCliLoggedInFromStatus } from '../electron/claude-cli-status';

describe('Claude CLI accountstatus', () => {
  it('accepteert uitsluitend een expliciet ingelogde CLI', () => {
    expect(claudeCliLoggedInFromStatus(JSON.stringify({
      loggedIn: true,
      authMethod: 'claude.ai',
      subscriptionType: 'pro',
    }))).toBe(true);
  });

  it('wijst een geïnstalleerde maar uitgelogde CLI af', () => {
    expect(claudeCliLoggedInFromStatus(JSON.stringify({ loggedIn: false }))).toBe(false);
  });

  it('behandelt ontbrekende of ongeldige status veilig als uitgelogd', () => {
    expect(claudeCliLoggedInFromStatus('{}')).toBe(false);
    expect(claudeCliLoggedInFromStatus('geen json')).toBe(false);
  });
});
