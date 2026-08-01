export interface OllamaStreamChunk {
  error?: unknown;
  done?: unknown;
  done_reason?: unknown;
  prompt_eval_count?: unknown;
  eval_count?: unknown;
  message?: {
    content?: unknown;
    thinking?: unknown;
    tool_calls?: unknown;
  };
}

export function ollamaChatRequestBody(
  model: string,
  messages: unknown[],
  extra: Record<string, unknown> = {},
) {
  return {
    model,
    messages,
    // Redeneermodellen mogen hun interne thinking niet als verborgen, trage
    // nevenuitvoer aan een gewone chatbeurt toevoegen. De native tool-loop kiest
    // per ronde bewust of thinking nodig is.
    think: false,
    ...extra,
    stream: true,
  };
}

export async function* parseOllamaNdjson(response: Response): AsyncGenerator<OllamaStreamChunk> {
  if (!response.body) throw new Error('Ollama gaf geen responsstream terug.');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.trim()) yield parseOllamaLine(line);
    }
    if (done) break;
  }

  if (buffer.trim()) yield parseOllamaLine(buffer);
}

function parseOllamaLine(line: string): OllamaStreamChunk {
  try {
    const parsed = JSON.parse(line);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('responsregel is geen JSON-object');
    }
    return parsed as OllamaStreamChunk;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Ollama stuurde ongeldige streamdata: ${detail}`);
  }
}
