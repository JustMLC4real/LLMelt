import { describe, expect, it } from 'vitest';
import { ollamaChatRequestBody, parseOllamaNdjson } from '../electron/ollama-stream';

function streamedResponse(chunks: string[]) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }));
}

describe('Ollama-streamprotocol', () => {
  it('schakelt thinking uit voor een gewone chatbeurt', () => {
    expect(ollamaChatRequestBody('qwen', [{ role: 'user', content: 'Hoi' }])).toEqual({
      model: 'qwen',
      messages: [{ role: 'user', content: 'Hoi' }],
      think: false,
      stream: true,
    });
  });

  it('laat de native tool-loop thinking bewust overschrijven', () => {
    expect(ollamaChatRequestBody('qwen', [], { think: true, tools: [] })).toMatchObject({
      think: true,
      tools: [],
      stream: true,
    });
  });

  it('verwerkt gesplitste regels en de laatste regel zonder newline', async () => {
    const response = streamedResponse([
      '{"message":{"content":"Hal',
      'lo"}}\n{"done":true,"eval_count":2}',
    ]);
    const chunks = [];
    for await (const chunk of parseOllamaNdjson(response)) chunks.push(chunk);
    expect(chunks).toEqual([
      { message: { content: 'Hallo' } },
      { done: true, eval_count: 2 },
    ]);
  });

  it('weigert niet-JSON en niet-object streamregels', async () => {
    for (const line of ['geen json', '[]']) {
      const consume = async () => {
        for await (const _chunk of parseOllamaNdjson(streamedResponse([line]))) {
          // consumeren om parserfouten zichtbaar te maken
        }
      };
      await expect(consume()).rejects.toThrow('Ollama stuurde ongeldige streamdata');
    }
  });
});
