/**
 * Leest de live uitvoer van `agy models` zonder modelnamen te verzinnen.
 * Nieuwe CLI-versies tonen `slug<TAB>weergavenaam`; alleen de slug is geldig
 * voor `agy --model`. Oudere versies tonen één modelwaarde per regel.
 */
export function parseAntigravityModelCatalog(output: string): string[] {
  const models = output
    .split(/\r?\n/)
    .map((rawLine) => rawLine.trim())
    .filter((line) => line && !/^fetching available models\b/i.test(line))
    .map((line) => {
      const [commandValue] = line.split(/\t+/);
      return commandValue.trim();
    })
    .filter(Boolean);

  return [...new Set(models)];
}
