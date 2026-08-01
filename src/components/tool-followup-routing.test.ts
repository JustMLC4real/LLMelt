import { describe, expect, it } from 'vitest';
import { toolFollowupRouting } from './tool-followup-routing';

describe('toolFollowupRouting', () => {
  it('houdt een follow-up aan dezelfde zichtbare chatbeurt gekoppeld', () => {
    expect(toolFollowupRouting('request-chat-a')).toEqual({
      requestId: 'request-chat-a',
      suppressDeltas: true,
    });
  });

  it('laat geen ongerouteerde follow-up zonder request-id toe', () => {
    expect(() => toolFollowupRouting('  ')).toThrow(/requestId/i);
  });
});
