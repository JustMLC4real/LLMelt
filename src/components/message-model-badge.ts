import type { ChatgptVersion, Message } from '../providers/types';
import {
  chatgptPresetLabel,
  codexModelLabel,
  reasoningEffortLabel,
} from './model-utils';

export function formatModelBadge(
  message: Message,
  chatgptVersions: ChatgptVersion[] = [],
) {
  if (!message.modelId) return '';
  const runConfig = parseBadgeRunConfig(message.runConfig);

  // ChatGPT: toon wat de gebruiker koos, niet de interne webslug.
  if (message.modelId.startsWith('chatgpt:')) {
    const label = chatgptPresetLabel(
      chatgptVersions,
      message.modelId,
      runConfig?.chatgptThinkingEffort,
    );
    if (label) return label;
  }

  const baseModelId = message.provider === 'codex'
    ? message.modelId.split('#')[0]
    : message.modelId;
  const effort = runConfig?.reasoningEffort;
  if (message.provider === 'codex') {
    const label = codexModelLabel(baseModelId);
    return ['Codex', label, effort && reasoningEffortLabel(effort)]
      .filter(Boolean)
      .join(' · ');
  }
  return baseModelId;
}

function parseBadgeRunConfig(raw?: string | null) {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as {
      reasoningEffort?: string;
      chatgptThinkingEffort?: string;
    };
  } catch {
    return null;
  }
}
