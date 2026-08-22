import type { ProviderType } from '../providers/types';

interface StreamingContentInput {
  provider: ProviderType;
  modelId: string;
  content: string;
}

const TOOL_MARKUP_START = /<\/?(?:file-|run-)(?:read|create|edit|command)?/i;

export function visibleStreamingContent({ provider, modelId, content }: StreamingContentInput): string {
  const isChatGptWeb = provider === 'openai' && modelId.startsWith('chatgpt:');
  if (isChatGptWeb && TOOL_MARKUP_START.test(content)) return '';
  return content;
}
