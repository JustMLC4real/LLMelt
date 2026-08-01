import { pythonRuntimeEnvironment } from './python-runtime';

export function agentCommandEnvironment(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return pythonRuntimeEnvironment({
    ...base,
    // Een verborgen Windows-shell heeft geen UTF-8-console. Zonder deze variabelen
    // crasht Python al bij gewone Unicode/emoji-output met de lokale cp1252-codepage.
    PYTHONIOENCODING: base.PYTHONIOENCODING ?? 'utf-8',
    PYTHONUTF8: base.PYTHONUTF8 ?? '1',
  });
}
