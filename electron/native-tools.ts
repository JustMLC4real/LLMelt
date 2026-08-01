import type { ProviderType } from '../src/providers/types';

export type NativeToolPhase = 'requested' | 'approved' | 'denied' | 'result';

/**
 * Providerneutraal event voor een tool die door een CLI-agent of lokaal model wordt
 * aangeroepen. De provider-runner vertaalt zijn eigen protocol naar dit formaat; de
 * IPC-laag verzorgt daarna voor alle providers dezelfde live kaart en persistentie.
 */
export interface NativeToolActivity {
  provider: ProviderType;
  toolName: string;
  input: Record<string, unknown>;
  toolUseId?: string;
  phase: NativeToolPhase;
  ok?: boolean;
  output?: string;
  detail?: string;
}

export interface NativePermissionDecision {
  allow: boolean;
  message?: string;
}

export type NativePermissionHandler = (
  toolName: string,
  input: Record<string, unknown>,
) => Promise<NativePermissionDecision>;

export interface NativeToolExecutionResult {
  ok: boolean;
  output: string;
  denied?: boolean;
}

export type NativeToolExecutor = (
  toolName: string,
  input: Record<string, unknown>,
  toolUseId?: string,
) => Promise<NativeToolExecutionResult>;

/**
 * De vier app-tools die modellen via hun eigen function-callingprotocol mogen
 * aanvragen. De IPC-laag blijft eigenaar van padvalidatie, approvals en uitvoering.
 */
export const NATIVE_APP_TOOL_DECLARATIONS = [
  {
    name: 'read_file',
    description: 'Lees één bestaand UTF-8-tekstbestand in de actieve projectmap. path moet een echt bestandspad zijn, nooit ".", een map of wildcard.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Relatief pad binnen de projectmap.' } },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Maak of overschrijf een UTF-8-tekstbestand in de actieve projectmap.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relatief pad binnen de projectmap.' },
        content: { type: 'string', description: 'Volledige nieuwe bestandsinhoud.' },
        overwrite: { type: 'boolean', description: 'Of een bestaand bestand mag worden overschreven.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description: 'Vervang exacte tekst in een bestaand UTF-8-bestand.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_text: { type: 'string' },
        new_text: { type: 'string' },
        replace_all: { type: 'boolean' },
      },
      required: ['path', 'old_text', 'new_text'],
    },
  },
  {
    name: 'run_command',
    description: 'Voer een shellcommando uit in de actieve projectmap. Laat shell normaal weg: de app gebruikt dan de ingestelde beschikbare standaardshell. Kies pwsh alleen als PowerShell 7 aantoonbaar is geïnstalleerd. Gebruik op Windows geen Unix-tools zoals tee of /dev/null.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        shell: { type: 'string', enum: ['powershell', 'cmd', 'pwsh'] },
      },
      required: ['command'],
    },
  },
] as const;

/** Ongeldige function-call-invoer wordt intern teruggegeven aan het model en nooit uitgevoerd. */
export function nativeToolInputProtocolError(toolName: string, input: Record<string, unknown>) {
  const normalizedName = toolName.trim().toLowerCase();
  if (['read_file', 'write_file', 'edit_file'].includes(normalizedName)) {
    const filePath = String(input.path || '').trim();
    if (!filePath) return `${normalizedName}.path ontbreekt; geef een relatief bestandspad.`;
    if (/^(?:\.|\.\.)$/.test(filePath) || /[\\/]$/.test(filePath) || /[*?]/.test(filePath)) {
      return `${normalizedName}.path moet één werkelijk bestand zijn, geen map of wildcard: ${filePath}`;
    }
  }
  if (normalizedName === 'run_command' && !String(input.command || '').trim()) {
    return 'run_command.command ontbreekt.';
  }
  if (normalizedName === 'run_command' && process.platform === 'win32') {
    const command = String(input.command || '').trim();
    const unixRedirection = /(?:^|[;&|]\s*|\s)(?:cat|tee)\s+[\s\S]*?(?:>{1,2}|<<)\s*/i.test(command)
      || /\|\s*cat(?:\s|$)/i.test(command)
      || /\/dev\/(?:null|stdout|stderr)\b/i.test(command);
    if (unixRedirection) {
      return 'Dit is Unix-shellsyntax en run_command mag geen bestandsinhoud schrijven. Gebruik write_file voor het bestand en daarna een apart Windows-commando om het uit te voeren.';
    }
  }
  return null;
}
