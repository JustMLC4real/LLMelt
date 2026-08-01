import fs from 'fs';
import path from 'path';

// Codex Desktop is aangetroffen met én zonder de tussenmap `Programs`. De actuele
// CLI kan in een versie-/hashmap staan terwijl de bovenste codex.exe ouder blijft.
// Vergelijk alle officiële desktoplocaties zodat Superapp dezelfde CLI-catalogus
// leest als de Codex-app zelf.
export function newestBundledCodexExecutable(localAppData = process.env.LOCALAPPDATA): string | null {
  if (!localAppData) return null;
  const binDirs = codexDesktopBinDirectories(localAppData);
  const candidates = binDirs.flatMap((binDir) => {
    const discovered = [path.join(binDir, 'codex.exe')];
    try {
      discovered.push(...fs.readdirSync(binDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(binDir, entry.name, 'codex.exe')));
    } catch {
      // Deze installatielocatie bestaat niet; de andere locatie blijft geldig.
    }
    return discovered;
  });

  return [...new Set(candidates)]
    .filter((candidate) => fs.existsSync(candidate))
    .map((candidate) => ({ candidate, modified: fs.statSync(candidate).mtimeMs }))
    .sort((left, right) => right.modified - left.modified)
    .at(0)?.candidate || null;
}

export function isCodexDesktopExecutable(
  executable: string,
  localAppData = process.env.LOCALAPPDATA,
) {
  if (!localAppData || !executable) return false;
  const resolved = path.resolve(executable).toLocaleLowerCase();
  return codexDesktopBinDirectories(localAppData).some((binDir) => {
    const root = `${path.resolve(binDir).toLocaleLowerCase()}${path.sep}`;
    return resolved.startsWith(root);
  });
}

function codexDesktopBinDirectories(localAppData: string) {
  return [
    path.join(localAppData, 'OpenAI', 'Codex', 'bin'),
    path.join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin'),
  ];
}
