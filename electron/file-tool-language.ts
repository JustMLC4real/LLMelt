import type { UiLanguage } from '../src/providers/types';
import { localizedText } from '../src/i18n/language';

export function fileReadDetail(filePath: string, chars: number, language: UiLanguage = 'nl') {
  return localizedText(language, `gelezen ${filePath} (${chars} tekens)`, `read ${filePath} (${chars} chars)`);
}

export function fileUnchangedDetail(filePath: string, chars: number, language: UiLanguage = 'nl') {
  return localizedText(language, `ongewijzigd ${filePath} (${chars} tekens)`, `unchanged ${filePath} (${chars} chars)`);
}

export function fileCreatedDetail(filePath: string, chars: number, language: UiLanguage = 'nl') {
  return localizedText(language, `gemaakt ${filePath} (${chars} tekens)`, `created ${filePath} (${chars} chars)`);
}

export function fileEditedDetail(filePath: string, deltaChars: number, language: UiLanguage = 'nl') {
  const delta = `${deltaChars >= 0 ? '+' : ''}${deltaChars}`;
  return localizedText(language, `bewerkt ${filePath} (${delta} tekens)`, `edited ${filePath} (${delta} chars)`);
}
