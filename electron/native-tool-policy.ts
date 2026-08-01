import { detectToolIntentRequest } from '../src/components/agent-commands';

export type AgentToolProtocol = 'none' | 'native' | 'tags';

export function selectAgentToolProtocol(options: {
  toolsEnabled: boolean;
  modelToolCapable: boolean;
}): AgentToolProtocol {
  if (!options.toolsEnabled) return 'none';
  return options.modelToolCapable ? 'native' : 'tags';
}

export function shouldStartNativeToolTurn(options: {
  toolsEnabled: boolean;
  modelToolCapable: boolean;
  userInput: string;
  recentMessages?: Array<{ role: string; content: string }>;
}) {
  return selectAgentToolProtocol(options) === 'native'
    && detectToolIntentRequest(options.userInput, options.recentMessages || []);
}

export function shouldUseTagToolProtocol(options: {
  toolsEnabled: boolean;
  modelToolCapable: boolean;
}) {
  return selectAgentToolProtocol(options) === 'tags';
}
