export interface ClaudeTextStreamState {
  currentMessageId?: string;
  partialTextByBlock: Map<string, string>;
  anonymousSequence: number;
}

export function createClaudeTextStreamState(): ClaudeTextStreamState {
  return { partialTextByBlock: new Map(), anonymousSequence: 0 };
}

export function claudeTextDeltasForEvent(event: any, state: ClaudeTextStreamState): string[] {
  if (!event || typeof event !== 'object') return [];
  if (event.type === 'stream_event') {
    const streamEvent = event.event;
    if (streamEvent?.type === 'message_start') {
      state.currentMessageId = typeof streamEvent.message?.id === 'string'
        ? streamEvent.message.id
        : `anoniem-${++state.anonymousSequence}`;
      return [];
    }
    const delta = streamEvent?.type === 'content_block_delta' && streamEvent.delta?.type === 'text_delta'
      ? streamEvent.delta.text
      : streamEvent?.type === 'content_block_start' && streamEvent.content_block?.type === 'text'
        ? streamEvent.content_block.text
        : undefined;
    if (typeof delta !== 'string' || !delta) return [];
    const messageId = state.currentMessageId || `anoniem-${++state.anonymousSequence}`;
    state.currentMessageId = messageId;
    const blockIndex = Number.isInteger(streamEvent.index) ? streamEvent.index : 0;
    const blockKey = `${messageId}:${blockIndex}`;
    state.partialTextByBlock.set(blockKey, `${state.partialTextByBlock.get(blockKey) || ''}${delta}`);
    return [delta];
  }

  if (event.type !== 'assistant' || !Array.isArray(event.message?.content)) return [];
  const messageId = typeof event.message?.id === 'string' ? event.message.id : state.currentMessageId;
  const deltas: string[] = [];
  for (const [index, part] of event.message.content.entries()) {
    if (part?.type !== 'text' || typeof part.text !== 'string' || !part.text) continue;
    const blockKey = messageId ? `${messageId}:${index}` : '';
    const partial = blockKey ? state.partialTextByBlock.get(blockKey) : undefined;
    if (partial === undefined) deltas.push(part.text);
    else if (part.text.startsWith(partial) && part.text.length > partial.length) deltas.push(part.text.slice(partial.length));
  }
  if (messageId) {
    for (const key of state.partialTextByBlock.keys()) {
      if (key.startsWith(`${messageId}:`)) state.partialTextByBlock.delete(key);
    }
  }
  state.currentMessageId = undefined;
  return deltas;
}

/** Claude kan met exitcode 0 toch een mislukte `result`-subtype rapporteren. */
export function claudeResultFailure(event: any): string | null {
  if (!event || event.type !== 'result') return null;
  if (event.is_error !== true && !String(event.subtype || '').startsWith('error')) return null;
  return String(event.result || event.error?.message || event.subtype || 'Claude rapporteerde een mislukte beurt.');
}
