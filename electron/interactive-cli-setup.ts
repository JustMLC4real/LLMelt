import type { UiLanguage } from '../src/providers/types';
import { localizedText } from '../src/i18n/language';

export type InteractiveCliKind = 'codex' | 'claude' | 'antigravity';

export function interactiveCliName(kind: InteractiveCliKind) {
  if (kind === 'codex') return 'Codex CLI';
  if (kind === 'claude') return 'Claude Code CLI';
  return 'Antigravity CLI';
}

export type InteractiveCliInstallerProgress = {
  phase: 'checking' | 'downloading' | 'installing';
  status: string;
  percent?: number;
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
};

function powershellLiteral(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

function installerUrl(kind: InteractiveCliKind) {
  if (kind === 'codex') return 'https://chatgpt.com/codex/install.ps1';
  if (kind === 'claude') return 'https://claude.ai/install.ps1';
  return 'https://antigravity.google/cli/install.ps1';
}

/**
 * Windows PowerShell 5.1 geeft `application/octet-stream` terug als `byte[]`.
 * Een directe `[string]`-cast maakt daarvan "91 67 109..." en is dus geen
 * geldige scripttekst. Download daarom naar een tijdelijk bestand, decodeer
 * expliciet als UTF-8 en verwijder het bestand ook bij een mislukte installer.
 */
export function downloadAndInvokePowerShellInstallerPowerShell(url: string, language: UiLanguage = 'nl') {
  return [
    "$installerScriptPath = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), ('ai-superapp-installer-' + [Guid]::NewGuid().ToString('N') + '.ps1'))",
    'try {',
    `    Invoke-AiSuperappDownload -Uri ${powershellLiteral(url)} -OutFile $installerScriptPath -TimeoutSec 30 -Label 'installer-script'`,
    '    [byte[]]$installerBytes = [System.IO.File]::ReadAllBytes($installerScriptPath)',
    '    $installerScript = [System.Text.Encoding]::UTF8.GetString($installerBytes)',
    `    if ([string]::IsNullOrWhiteSpace($installerScript)) { throw ${powershellLiteral(localizedText(language, 'De officiële installer gaf geen script terug.', 'The official installer returned an empty script.'))} }`,
    '    & ([scriptblock]::Create($installerScript))',
    '} finally {',
    '    if ([System.IO.File]::Exists($installerScriptPath)) { [System.IO.File]::Delete($installerScriptPath) }',
    '}',
  ].join('\n');
}

/**
 * De officiële scripts verbergen PowerShell-progress en downloaden hun grote
 * payload met Invoke-WebRequest -OutFile. Deze tijdelijke proxy verandert niet
 * wat of waar de provider installeert: hij streamt uitsluitend diezelfde URL
 * naar hetzelfde doelbestand en meldt daarbij aantoonbare bytevoortgang.
 */
export function progressAwareInvokeWebRequestPowerShell() {
  return `
function Invoke-AiSuperappDownload {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][uri]$Uri,
        [Parameter(Mandatory = $true)][string]$OutFile,
        [int]$TimeoutSec = 300,
        [ValidateSet('installer-script', 'payload')][string]$Label = 'payload'
    )

    Add-Type -AssemblyName System.Net.Http
    $handler = New-Object System.Net.Http.HttpClientHandler
    $client = New-Object System.Net.Http.HttpClient($handler)
    $response = $null
    $source = $null
    $target = $null
    try {
        $client.Timeout = [TimeSpan]::FromSeconds([Math]::Max(1, $TimeoutSec))
        $response = $client.GetAsync(
            $Uri,
            [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead
        ).GetAwaiter().GetResult()
        $response.EnsureSuccessStatusCode()

        [long]$total = 0
        if ($null -ne $response.Content.Headers.ContentLength) {
            $total = [long]$response.Content.Headers.ContentLength
        }
        $directory = [System.IO.Path]::GetDirectoryName([System.IO.Path]::GetFullPath($OutFile))
        if (-not [string]::IsNullOrWhiteSpace($directory)) {
            [System.IO.Directory]::CreateDirectory($directory) | Out-Null
        }

        $source = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
        $target = New-Object System.IO.FileStream(
            $OutFile,
            [System.IO.FileMode]::Create,
            [System.IO.FileAccess]::Write,
            [System.IO.FileShare]::None,
            65536,
            [System.IO.FileOptions]::SequentialScan
        )
        $buffer = New-Object byte[] 65536
        [long]$transferred = 0
        $startedAt = [DateTime]::UtcNow
        $lastReportAt = $startedAt
        [int]$lastPercent = -1
        [Console]::Out.WriteLine("AI_SUPERAPP_DOWNLOAD|$Label|0|$total|0|0")

        while (($read = $source.Read($buffer, 0, $buffer.Length)) -gt 0) {
            $target.Write($buffer, 0, $read)
            $transferred += $read
            $now = [DateTime]::UtcNow
            $elapsed = [Math]::Max(0.001, ($now - $startedAt).TotalSeconds)
            [long]$bytesPerSecond = [long]($transferred / $elapsed)
            $percent = if ($total -gt 0) {
                [Math]::Min(100, [Math]::Floor(($transferred * 100.0) / $total))
            } else {
                -1
            }
            if (
                $percent -gt $lastPercent -or
                ($now - $lastReportAt).TotalMilliseconds -ge 500
            ) {
                [Console]::Out.WriteLine(
                    "AI_SUPERAPP_DOWNLOAD|$Label|$transferred|$total|$bytesPerSecond|$percent"
                )
                $lastPercent = $percent
                $lastReportAt = $now
            }
        }
        $target.Flush()
        $finishedAt = [DateTime]::UtcNow
        $totalSeconds = [Math]::Max(0.001, ($finishedAt - $startedAt).TotalSeconds)
        [long]$finalBytesPerSecond = [long]($transferred / $totalSeconds)
        $finalPercent = if ($total -gt 0) { 100 } else { -1 }
        [Console]::Out.WriteLine(
            "AI_SUPERAPP_DOWNLOAD|$Label|$transferred|$total|$finalBytesPerSecond|$finalPercent"
        )
    } finally {
        if ($null -ne $target) { $target.Dispose() }
        if ($null -ne $source) { $source.Dispose() }
        if ($null -ne $response) { $response.Dispose() }
        $client.Dispose()
        $handler.Dispose()
    }
}

function Invoke-WebRequest {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$Uri,
        [string]$OutFile,
        [switch]$UseBasicParsing,
        [int]$TimeoutSec = 0
    )

    if (-not [string]::IsNullOrWhiteSpace($OutFile)) {
        $effectiveTimeout = if ($TimeoutSec -gt 0) { $TimeoutSec } else { 300 }
        Invoke-AiSuperappDownload -Uri ([uri]$Uri) -OutFile $OutFile -TimeoutSec $effectiveTimeout
        return
    }

    $forward = @{ Uri = $Uri }
    if ($UseBasicParsing) { $forward.UseBasicParsing = $true }
    if ($TimeoutSec -gt 0) { $forward.TimeoutSec = $TimeoutSec }
    if ($PSBoundParameters.ContainsKey('ErrorAction')) {
        $forward.ErrorAction = $PSBoundParameters['ErrorAction']
    }
    Microsoft.PowerShell.Utility\\Invoke-WebRequest @forward
}
`.trim();
}

/** Alleen vaste, officiële installers; er komt geen rendererinput in deze commando's. */
export function interactiveCliInstallPowerShell(kind: InteractiveCliKind, language: UiLanguage = 'nl') {
  const name = interactiveCliName(kind);
  return [
    "$ErrorActionPreference = 'Stop'",
    ...(kind === 'codex' ? ["$env:CODEX_NON_INTERACTIVE = '1'"] : []),
    `Write-Host ${powershellLiteral(localizedText(language, `${name} wordt geïnstalleerd...`, `Installing ${name}...`))} -ForegroundColor Cyan`,
    progressAwareInvokeWebRequestPowerShell(),
    downloadAndInvokePowerShellInstallerPowerShell(installerUrl(kind), language),
  ].join("\n");
}

export function interactiveCliLaunchPowerShell(kind: InteractiveCliKind, executablePath: string) {
  const args = kind === 'codex'
    ? ' login'
    : kind === 'claude'
      ? ' auth login'
      : '';
  return `& ${powershellLiteral(executablePath)}${args}`;
}

/**
 * Start-Process maakt vanuit de verborgen Electron-helper een echt, zichtbaar
 * consolevenster. De marker wordt pas geschreven als het loginproces na een
 * korte controle nog leeft; alleen een geslaagde spawn is daarvoor te zwak.
 */
export function interactiveCliTerminalLauncherPowerShell(
  kind: InteractiveCliKind,
  executablePath: string,
  workingDirectory: string,
  language: UiLanguage = 'nl',
) {
  const name = interactiveCliName(kind);
  const childCommand = [
    `$Host.UI.RawUI.WindowTitle = ${powershellLiteral(`LLMelt - ${name} login`)}`,
    `Write-Host ${powershellLiteral(localizedText(language, `${name}-login gestart door LLMelt.`, `${name} sign-in started by LLMelt.`))} -ForegroundColor Cyan`,
    `Write-Host ${powershellLiteral(localizedText(language, 'Rond de login hier af. Dit venster mag daarna worden gesloten.', 'Complete the sign-in here. You can close this window afterwards.'))}`,
    interactiveCliLaunchPowerShell(kind, executablePath),
  ].join("\n");
  const encodedCommand = Buffer.from(childCommand, 'utf16le').toString('base64');
  const childArguments = [
    '-NoLogo',
    '-NoProfile',
    '-NoExit',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    encodedCommand,
  ].map(powershellLiteral).join(', ');

  return [
    "$ErrorActionPreference = 'Stop'",
    `$loginProcess = Start-Process -FilePath 'powershell.exe' -ArgumentList @(${childArguments}) -WorkingDirectory ${powershellLiteral(workingDirectory)} -WindowStyle Normal -PassThru`,
    'Start-Sleep -Milliseconds 900',
    `if ($loginProcess.HasExited) { throw ${powershellLiteral(localizedText(language, `${name}-loginvenster sloot direct na het openen.`, `${name} sign-in window closed immediately after opening.`))} }`,
    "Write-Output ('AI_SUPERAPP_LOGIN_PID|' + $loginProcess.Id)",
  ].join("\n");
}

export function parseInteractiveCliInstallerProgress(
  kind: InteractiveCliKind,
  output: string,
  language: UiLanguage = 'nl',
): InteractiveCliInstallerProgress | null {
  const ansiSequence = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g');
  const normalized = String(output || '')
    .replace(ansiSequence, '')
    .replace(/\r/g, '\n');
  if (!normalized.trim()) return null;

  const name = interactiveCliName(kind);
  const byteProgress = [...normalized.matchAll(
    /AI_SUPERAPP_DOWNLOAD\|(?:(installer-script|payload)\|)?(\d+)\|(\d+)\|(\d+)\|(-?\d+)/g,
  )].at(-1);
  const phasePattern = /installed successfully|installation complete|install complete|successfully installed|verifying|checksum|signature|resolved version|downloading|download\b|fetching|installing|setting up|extracting|updating (?:the )?path|adding .*path/i;
  const outputAfterByteMarker = byteProgress
    ? normalized.slice((byteProgress.index ?? 0) + byteProgress[0].length)
    : '';
  if (byteProgress && !phasePattern.test(outputAfterByteMarker)) {
    const label = byteProgress[1] || 'payload';
    const transferred = Number(byteProgress[2]);
    const total = Number(byteProgress[3]);
    const bytesPerSecond = Number(byteProgress[4]);
    const rawMarkerPercent = Number(byteProgress[5]);
    const markerPercent = rawMarkerPercent >= 0 && rawMarkerPercent <= 100
      ? Math.round(rawMarkerPercent)
      : undefined;
    const progressLabel = label === 'installer-script'
      ? localizedText(language, `${name}-installatiescript ophalen`, `Fetching ${name} installer script`)
      : localizedText(language, `${name} downloaden`, `Downloading ${name}`);
    return {
      phase: 'downloading',
      status: `${progressLabel}${markerPercent === undefined ? '...' : `... ${markerPercent}%`}`,
      ...(markerPercent === undefined ? {} : { percent: markerPercent }),
      transferred,
      total,
      bytesPerSecond,
    };
  }

  // runSetupProcess levert opgebouwde uitvoer. Een oudere downloadmarker mag
  // daarom een nieuwere controle-/installatiefase niet op 100% vastzetten.
  const phaseOutput = byteProgress ? outputAfterByteMarker : normalized;
  const percentages = [...phaseOutput.matchAll(/(\d+(?:[.,]\d+)?)\s*%/g)];
  const rawPercent = percentages.at(-1)?.[1]?.replace(',', '.');
  const percent = rawPercent === undefined
    ? undefined
    : Math.min(100, Math.max(0, Math.round(Number(rawPercent))));

  if (/installed successfully|installation complete|install complete|successfully installed/i.test(phaseOutput)) {
    return {
      phase: 'installing',
      status: localizedText(language, `${name} is geïnstalleerd.`, `${name} is installed.`),
      percent: 100,
    };
  }
  if (/verifying|checksum|signature|resolved version/i.test(phaseOutput)) {
    return {
      phase: 'checking',
      status: localizedText(language, `${name}-download controleren...`, `Verifying ${name} download...`),
      ...(percent === undefined ? {} : { percent }),
    };
  }
  if (/downloading|download\b|fetching/i.test(phaseOutput) || percent !== undefined) {
    return {
      phase: 'downloading',
      status: `${localizedText(language, `${name} downloaden`, `Downloading ${name}`)}${percent === undefined ? '...' : `... ${percent}%`}`,
      ...(percent === undefined ? {} : { percent }),
    };
  }
  if (/installing|setting up|extracting|updating (?:the )?path|adding .*path/i.test(phaseOutput)) {
    return {
      phase: 'installing',
      status: localizedText(language, `${name} installeren...`, `Installing ${name}...`),
    };
  }
  return null;
}
