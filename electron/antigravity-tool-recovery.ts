import fs from 'node:fs';
import path from 'node:path';
import { localizedText } from '../src/i18n/language';
import type { UiLanguage } from '../src/providers/types';

export interface UnreportedAntigravityTool {
  name: string;
  input: Record<string, unknown>;
}

export interface RecoveredAntigravityToolResult {
  ok: boolean;
  output: string;
}

/**
 * Verifieert uitsluitend een reeds waarneembaar bestandseffect na een vroege
 * CLI-exit. Deze route voert nooit alsnog een tool uit en claimt geen succes
 * voor commando's of wijzigingen die niet exact vanaf schijf zijn te bewijzen.
 */
export async function recoverUnreportedAntigravityTool(
  tool: UnreportedAntigravityTool,
  cwd: string,
  language: UiLanguage = 'nl',
): Promise<RecoveredAntigravityToolResult | null> {
  const name = tool.name.trim().toLowerCase();
  if (!['write_to_file', 'write_file', 'write'].includes(name)) return null;

  const requestedPath = firstString(tool.input, [
    'TargetFile', 'targetFile', 'target_file', 'path', 'filePath', 'file_path',
  ]);
  const expectedContent = firstString(tool.input, [
    'CodeContent', 'codeContent', 'code_content', 'content', 'text',
  ]);
  if (!requestedPath || expectedContent === undefined) return null;

  const root = path.resolve(cwd);
  const target = path.resolve(root, requestedPath);
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;

  let actual: string;
  try {
    actual = await fs.promises.readFile(target, 'utf8');
  } catch {
    return {
      ok: false,
      output: localizedText(
        language,
        `Antigravity sloot voor bevestiging; het verwachte bestand bestaat niet: ${path.relative(root, target) || path.basename(target)}.`,
        `Antigravity closed before confirmation; the expected file does not exist: ${path.relative(root, target) || path.basename(target)}.`,
      ),
    };
  }
  if (canonicalFileText(actual) !== canonicalFileText(expectedContent)) {
    return {
      ok: false,
      output: localizedText(
        language,
        `Antigravity sloot voor bevestiging; ${path.relative(root, target) || path.basename(target)} bestaat, maar bevat niet de aangevraagde inhoud.`,
        `Antigravity closed before confirmation; ${path.relative(root, target) || path.basename(target)} exists, but does not contain the requested content.`,
      ),
    };
  }

  return {
    ok: true,
    output: localizedText(
      language,
      `Bestandseffect na CLI-exit geverifieerd: ${path.relative(root, target) || path.basename(target)}.`,
      `Verified file effect after CLI exit: ${path.relative(root, target) || path.basename(target)}.`,
    ),
  };
}

function canonicalFileText(value: string) {
  return value.replace(/\r\n/g, '\n').replace(/\n$/, '');
}

function firstString(input: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof input[key] === 'string') return input[key] as string;
  }
  return undefined;
}
