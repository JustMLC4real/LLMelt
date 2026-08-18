# 8. Build, packaging, auto-update & release

## 8.1 npm-scripts

| script | doet |
|---|---|
| `npm run dev` | Vite-dev + Electron 43, met hot reload. |
| `npm run lint` | ESLint voor TypeScript, React en scripts. |
| `npm test` | Logica-, fresh-start-, native-tool- en securitytests. |
| `npm run test:coverage` | Tests plus minimumcoverage: 60% regels/functions/statements en 50% branches. |
| `npm run build` | TypeScript + Vite naar `dist/` en `dist-electron/`. |
| `npm run package` | Build + electron-builder + NSIS-installer in `release/`. |
| `npm run package:portable` | Hetzelfde als portable Windows-exe. |
| `npm run verify:release` | Controleert de lokale releaseartefacten zonder upload. |
| `npm run publish:update` | Gecontroleerde upload van een bestaande release. |
| `npm run release` | Package + gecontroleerde upload. |

De database gebruikt Node 24/Electron's ingebouwde `node:sqlite`; er is geen losse native
`better-sqlite3`-ABI. `node-pty` levert Windows-prebuilds, daarom is `npmRebuild=false` bewust.

## 8.2 electron-builder

- `appId`: `com.superapp.ai` (bewuste legacy-ID voor updatecompatibiliteit);
  productnaam: `LLMelt`.
- De package-naam is `LLMelt`; `main.ts` houdt voor bestaande data bewust het verborgen
  legacyprofiel `%APPDATA%/ai-superapp` aan. Verander dat pad niet zonder datamigratie.
- Alleen `dist/`, `dist-electron/` en `package.json` gaan in de app.
- Windowsdoel is een begeleide NSIS-installer. Een losse installatie toont de keuze
  **alleen deze gebruiker / alle gebruikers** en laat de installatiemap kiezen; alleen de
  keuze voor alle gebruikers vraagt zo nodig elevatie. Een in-app-update installeert
  dezelfde NSIS-build stil op de al gekozen locatie.
- Icoon en versie-resources lopen via electron-builder's standaard Windowsroute.
- De enige updateprovider is de publieke GitHub-repository `JustMLC4real/LLMelt`.
  Electron-builder schrijft deze provider naar `app-update.yml`; `electron-updater` vindt de
  nieuwste stabiele publicatie via `https://github.com/JustMLC4real/LLMelt/releases`.
- Code signing is optioneel. Zonder gratis publiek vertrouwd certificaat worden releases bewust
  unsigned gebouwd. Een later beschikbare gratis signingroute kan gewoon weer worden aangesloten.

Artefacten:

```text
release/LLMelt-Setup-<versie>.exe
release/LLMelt-Setup-<versie>.exe.blockmap
release/latest.yml
```

## 8.3 Auto-update

`electron/updater.ts` controleert vier seconden na opstart en daarna elke dertig minuten.
`autoDownload=true` en `autoInstallOnAppQuit=false`: een gevonden update downloadt automatisch,
maar installeren gebeurt uitsluitend na **Nu installeren & herstarten**. Tijdens de download toont
het paneel percentage, ontvangen/totale bestandsgrootte en downloadsnelheid.
`quitAndInstall(true, true)` voorkomt dat de standalone installatiewizard tijdens een update
opnieuw om een map vraagt.

Electron-updater vergelijkt de versie en verifieert de SHA-512 uit `latest.yml`. Omdat unsigned
releases geen onafhankelijke Authenticode-herkomstcontrole hebben, is de releasehash geen vervanging
voor signing. Beveilig daarom het GitHub-account, de repositoryrechten en eventuele Actions-secrets.

## 8.4 Publicatiebeveiliging

`scripts/publish-update.mjs` weigert publicatie wanneer:

- een artefact ontbreekt;
- de Git-worktree niet schoon is;
- de huidige branch niet `main` is of HEAD nog niet rechtstreeks op `origin/main` staat;
- tag `v<versie>` niet naar HEAD wijst;
- de tag nog niet naar `origin` is gepusht;
- de lokale SHA-512 niet overeenkomt met `latest.yml`;
- de repository niet publiek is;
- op GitHub al dezelfde of een hogere stabiele versie staat.

Authenticode wordt nog gerapporteerd, maar `NotSigned` blokkeert publicatie niet. Zo kan een later
gratis verkregen certificaat automatisch benut worden zonder unsigned releases nu onmogelijk te maken.

Het script publiceert installer, blockmap en `latest.yml` samen als één stabiele GitHub Release en
controleert daarna via de GitHub API of de release niet draft/prerelease is en ieder artefact met de
juiste bestandsgrootte en SHA-256-serverdigest aanwezig is. Ook moeten alle publieke download-URL's
HTTP 200 geven en moet de gepubliceerde `latest.yml` de lokale SHA-512 van de installer bevatten. Een
private repository wordt bewust geweigerd: eindgebruikers hebben geen GitHub-token en zouden daar dus
geen automatische updates uit kunnen ophalen.

## 8.5 Release-recept

1. `npm run lint`
2. `npm run test:coverage`
3. `npm audit --audit-level=low`
4. `npm run build`
5. Versie verhogen met `npm version <versie> --no-git-tag-version`.
6. Commit direct op `main`, tag `v<versie>` en push commit + tag.
7. Maak en verifieer een git-bundle én een tar/patch-snapshot voor dirty/untracked herstel.
8. `npm run package` en daarna `npm run verify:release`.
9. `npm run publish:update`; alle overige gates en remote controles zijn afgedwongen.

Backups staan onder
`C:/Users/Justin/Downloads/Codex/LLMelt-backups/LLMelt-<datum>-v<versie>.*`.

## 8.6 CI

`.github/workflows/ci.yml` draait op Windows met Node 24: `npm ci`, security-audit, lint, een
expliciete fresh-start/runtimecontracttest, de volledige testsuite en build. De repository bevat
bron en documentatie; logs, databases en buildartefacten blijven genegeerd.
