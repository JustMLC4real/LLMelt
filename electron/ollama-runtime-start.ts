import path from 'path';

export function ollamaProbeBaseUrls(configuredBaseUrl: string) {
  const configured = String(configuredBaseUrl || '').trim().replace(/\/+$/, '');
  if (!configured) return ['http://127.0.0.1:11434', 'http://localhost:11434'];
  const urls = [configured];
  try {
    const parsed = new URL(configured);
    const hostname = parsed.hostname.toLocaleLowerCase();
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1') {
      const ipv4 = new URL(parsed);
      ipv4.hostname = '127.0.0.1';
      urls.push(ipv4.toString().replace(/\/+$/, ''));
      const localhost = new URL(parsed);
      localhost.hostname = 'localhost';
      urls.push(localhost.toString().replace(/\/+$/, ''));
    }
  } catch {
    // De geconfigureerde waarde blijft als enige probe over; validatie geeft de fout.
  }
  return [...new Set(urls)];
}

export function ollamaWindowsStartCandidates(cliExecutable: string) {
  return [
    {
      file: path.join(path.dirname(cliExecutable), 'ollama app.exe'),
      args: [] as string[],
      label: 'Ollama Windows-app',
      requiresExistingFile: true,
    },
    {
      file: cliExecutable,
      args: ['serve'],
      label: 'ollama serve',
      requiresExistingFile: false,
    },
  ];
}

export function conciseOllamaStartupDiagnostic(...chunks: Array<string | null | undefined>) {
  const lines = chunks
    .flatMap((chunk) => String(chunk || '').split(/\r?\n/))
    .map((line) => line.trim())
    .filter(Boolean);
  return [...new Set(lines)].slice(-12).join('\n').slice(-3_000);
}
