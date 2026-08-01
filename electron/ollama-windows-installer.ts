export const OLLAMA_WINDOWS_INSTALLER_URL = 'https://ollama.com/download/OllamaSetup.exe';

export const OLLAMA_WINDOWS_INSTALLER_ARGS = [
  '/VERYSILENT',
  '/NORESTART',
  '/SUPPRESSMSGBOXES',
] as const;

function powershellLiteral(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * De officiële Ollama-installatiescript controleert dezelfde Authenticode-
 * status en organisatie. De app doet dit vóór uitvoering van de direct
 * gedownloade installer, zonder PowerShell-download-cradle.
 */
export function ollamaAuthenticodeVerificationPowerShell(installerPath: string) {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$signature = Get-AuthenticodeSignature -LiteralPath ${powershellLiteral(installerPath)}`,
    "if ($signature.Status -ne 'Valid') { throw ('De digitale handtekening van Ollama is niet geldig: ' + $signature.Status) }",
    "if ($null -eq $signature.SignerCertificate) { throw 'De Ollama-installer heeft geen ondertekenaar.' }",
    '$subject = [string]$signature.SignerCertificate.Subject',
    "if ($subject -notmatch '(^|,\\s*)O=Ollama Inc\\.(,|$)') { throw ('Onverwachte Ollama-ondertekenaar: ' + $subject) }",
    "Write-Output 'AI_SUPERAPP_OLLAMA_SIGNATURE_VALID'",
  ].join('\n');
}
