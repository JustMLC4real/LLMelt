import { describe, expect, it } from 'vitest';
import { claudeResultFailure, claudeTextDeltasForEvent, createClaudeTextStreamState } from '../electron/claude-stream';

describe('Claude partial-message streaming', () => {
  it('streamt tekstdelta’s en dupliceert de afsluitende assistanttekst niet', () => {
    const state = createClaudeTextStreamState();
    expect(claudeTextDeltasForEvent({
      type: 'stream_event',
      event: { type: 'message_start', message: { id: 'msg-1' } },
    }, state)).toEqual([]);
    expect(claudeTextDeltasForEvent({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hal' } },
    }, state)).toEqual(['Hal']);
    expect(claudeTextDeltasForEvent({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } },
    }, state)).toEqual(['lo']);
    expect(claudeTextDeltasForEvent({
      type: 'assistant',
      message: { id: 'msg-1', content: [{ type: 'text', text: 'Hallo' }] },
    }, state)).toEqual([]);
  });

  it('levert een ontbrekend afsluitend suffix alsnog uit', () => {
    const state = createClaudeTextStreamState();
    claudeTextDeltasForEvent({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg-2' } } }, state);
    claudeTextDeltasForEvent({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hal' } } }, state);
    expect(claudeTextDeltasForEvent({
      type: 'assistant',
      message: { id: 'msg-2', content: [{ type: 'text', text: 'Hallo' }] },
    }, state)).toEqual(['lo']);
  });

  it('blijft compatibel met CLI-versies zonder partial events', () => {
    const state = createClaudeTextStreamState();
    expect(claudeTextDeltasForEvent({
      type: 'assistant',
      message: { id: 'msg-3', content: [{ type: 'text', text: 'Volledig blok' }] },
    }, state)).toEqual(['Volledig blok']);
  });

  it('dedupliceert meerdere tekstblokken per assistantbericht afzonderlijk', () => {
    const state = createClaudeTextStreamState();
    claudeTextDeltasForEvent({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg-4' } } }, state);
    expect(claudeTextDeltasForEvent({
      type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'voor' } },
    }, state)).toEqual(['voor']);
    expect(claudeTextDeltasForEvent({
      type: 'stream_event', event: { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'na' } },
    }, state)).toEqual(['na']);
    expect(claudeTextDeltasForEvent({
      type: 'assistant',
      message: { id: 'msg-4', content: [
        { type: 'text', text: 'voor' },
        { type: 'tool_use', name: 'Read' },
        { type: 'text', text: 'na' },
      ] },
    }, state)).toEqual([]);
  });
});

describe('Claude eindstatus', () => {
  it('behandelt een error-subtype niet als geslaagd antwoord', () => {
    expect(claudeResultFailure({
      type: 'result',
      subtype: 'error_max_turns',
      is_error: true,
      result: 'Maximum aantal stappen bereikt.',
    })).toBe('Maximum aantal stappen bereikt.');
  });

  it('laat een normale result-status door', () => {
    expect(claudeResultFailure({ type: 'result', subtype: 'success', result: 'Klaar.' })).toBeNull();
  });
});
