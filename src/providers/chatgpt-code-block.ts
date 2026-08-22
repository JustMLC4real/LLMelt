/**
 * Verwijdert alleen zichtbare ChatGPT-codeblokbediening die soms door de
 * website-DOM in `pre.innerText` terechtkomt. Gewone broncode blijft exact
 * behouden; een taalnaam zonder bedieningslabel wordt niet aangepast.
 */
export function cleanChatGptCodeBlockText(value: string, languageHint = ''): string {
  const original = String(value || '');
  const normalized = original.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  const actionLabels = new Set([
    'run', 'run code', 'execute', 'execute code', 'copy', 'copy code',
    'uitvoeren', 'code uitvoeren', 'kopieren', 'code kopieren',
  ]);
  const languageLabels = new Set([
    'bash', 'bat', 'batch', 'c', 'c#', 'c++', 'cmd', 'css', 'go', 'html', 'java',
    'javascript', 'js', 'json', 'jsx', 'kotlin', 'php', 'powershell', 'ps1', 'pwsh',
    'py', 'python', 'ruby', 'rust', 'shell', 'sh', 'sql', 'swift', 'tsx',
    'typescript', 'ts', 'xml', 'yaml', 'yml',
  ]);
  const label = (line: string) => line.trim().toLocaleLowerCase('en-US')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  let firstContent = 0;
  while (firstContent < lines.length && !lines[firstContent].trim()) firstContent++;
  const first = label(lines[firstContent] || '');
  const second = label(lines[firstContent + 1] || '');
  const hint = label(languageHint);
  let start = 0;
  let changed = false;

  if (actionLabels.has(first)) {
    start = firstContent + 1;
    changed = true;
  } else if ((languageLabels.has(first) || (!!hint && first === hint)) && actionLabels.has(second)) {
    start = firstContent + 2;
    changed = true;
  }

  let lastContent = lines.length - 1;
  while (lastContent >= start && !lines[lastContent].trim()) lastContent--;
  let end = lines.length;
  if (lastContent >= start && actionLabels.has(label(lines[lastContent]))) {
    end = lastContent;
    changed = true;
  }

  // ChatGPT Web laat soms één of twee backticks van de visuele sluitfence
  // achter in `pre > code`. De scraper zet daarna zelf de echte drie backticks
  // om het DOM-codeblok; zonder deze stap belandt het fragment letterlijk in
  // het bestand. Beperk dit tot Python, waar zo'n losse regel altijd ongeldig is.
  let trailingContent = end - 1;
  while (trailingContent >= start && !lines[trailingContent].trim()) trailingContent--;
  if (
    (hint === 'python' || hint === 'py')
    && trailingContent >= start
    && /^`{1,2}$/.test(lines[trailingContent].trim())
  ) {
    end = trailingContent;
    changed = true;
  }

  return changed ? lines.slice(start, end).join('\n') : original;
}
