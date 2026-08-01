import fs from 'fs';
import path from 'path';

function isInside(rootPath: string, targetPath: string) {
  const relative = path.relative(rootPath, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function canonicalTarget(targetPath: string, allowMissing: boolean) {
  if (fs.existsSync(targetPath)) return fs.promises.realpath(targetPath);
  if (!allowMissing) throw new Error('Doelpad bestaat niet.');
  let existing = targetPath;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) throw new Error('Geen bestaande oudermap gevonden.');
    existing = parent;
  }
  const realExisting = await fs.promises.realpath(existing);
  return path.resolve(realExisting, path.relative(existing, targetPath));
}

export async function isRealPathInsideRoot(root: string, requestedPath: string, allowMissing = true) {
  try {
    const lexicalRoot = path.resolve(root);
    const lexicalTarget = path.isAbsolute(requestedPath)
      ? path.resolve(requestedPath)
      : path.resolve(lexicalRoot, requestedPath);
    if (!isInside(lexicalRoot, lexicalTarget)) return false;
    const realRoot = await fs.promises.realpath(lexicalRoot);
    // Als de werkmap zélf een junction is (bijvoorbeeld Documents -> OneDrive),
    // moet dezelfde relatieve doelnaam onder de canonieke root worden beoordeeld.
    // Daarna resolveert canonicalTarget eventuele junctions ín de werkmap alsnog,
    // zodat een interne link naar buiten niet door deze normalisatie kan glippen.
    const relativeTarget = path.relative(lexicalRoot, lexicalTarget);
    const canonicalCandidate = path.resolve(realRoot, relativeTarget);
    const realTarget = await canonicalTarget(canonicalCandidate, allowMissing);
    return isInside(realRoot, realTarget);
  } catch {
    return false;
  }
}

export async function assertRealPathInsideRoot(root: string, requestedPath: string, allowMissing = true) {
  if (!await isRealPathInsideRoot(root, requestedPath, allowMissing)) {
    throw new Error(`Pad is niet veilig bereikbaar binnen de toegestane werkmap: ${requestedPath}`);
  }
}

export function canAutoApproveAgentAction(mode: string, kind: string | undefined, pathInsideRoot: boolean) {
  return mode === 'auto-project' && kind !== 'command' && !!kind && pathInsideRoot;
}
