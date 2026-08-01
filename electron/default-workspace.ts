import path from 'node:path';

export const DEFAULT_WORKSPACE_NAME = 'LLMelt';
export const LEGACY_WORKSPACE_NAME = 'AI Superapp';

export function selectDefaultWorkspacePath(
  documentsPath: string,
  exists: (candidate: string) => boolean,
) {
  const workspace = path.join(documentsPath, DEFAULT_WORKSPACE_NAME);
  const legacyWorkspace = path.join(documentsPath, LEGACY_WORKSPACE_NAME);
  if (!exists(workspace) && exists(legacyWorkspace)) return legacyWorkspace;
  return workspace;
}
