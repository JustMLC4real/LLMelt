import fs from 'fs';
import os from 'os';
import path from 'path';
import { app } from 'electron';
import { getStore } from './settings-store';

export type StatuslineBridgeProvider = 'claude' | 'antigravity';

const MISSING = '__LLMELT_MISSING__';

export async function ensureStatuslineBridge(provider: StatuslineBridgeProvider) {
  const configPath = settingsPath(provider);
  const statePath = statuslineStatePath(provider);
  const scriptPath = ensureBridgeScript();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const settings = readJson(configPath);
  const store = await getStore();
  const backupKey = `quotaBridge.backups.${provider}`;
  if (!store.has(backupKey)) store.set(backupKey, settings.statusLine ?? MISSING);
  const original = isLlmeltStatusline(settings.statusLine) ? null : settings.statusLine;
  settings.statusLine = {
    type: 'command',
    command: bridgeCommand(scriptPath, provider, statePath, original),
    padding: 0,
  };
  writeJsonAtomic(configPath, settings);
  return { provider, configPath, statePath, chained: !!original };
}

export async function restoreStatuslineBridge(provider: StatuslineBridgeProvider) {
  const store = await getStore();
  const backupKey = `quotaBridge.backups.${provider}`;
  if (!store.has(backupKey)) return { restored: false, message: 'Geen LLMelt-statusregelbackup gevonden.' };
  const settings = readJson(settingsPath(provider));
  const backup = store.get(backupKey);
  if (backup === MISSING) delete settings.statusLine;
  else settings.statusLine = backup;
  writeJsonAtomic(settingsPath(provider), settings);
  store.delete(backupKey);
  return { restored: true };
}

export function statuslineStatePath(provider: StatuslineBridgeProvider) {
  return path.join(app.getPath('userData'), 'quota-status', `${provider}.json`);
}

function settingsPath(provider: StatuslineBridgeProvider) {
  return provider === 'claude'
    ? path.join(os.homedir(), '.claude', 'settings.json')
    : path.join(os.homedir(), '.gemini', 'antigravity-cli', 'settings.json');
}

function ensureBridgeScript() {
  const directory = path.join(app.getPath('userData'), 'quota-status');
  fs.mkdirSync(directory, { recursive: true });
  const scriptPath = path.join(directory, 'statusline-bridge.cjs');
  const source = String.raw`const fs=require('fs');const cp=require('child_process');
const provider=process.argv[2],statePath=process.argv[3],chain=process.argv[4]?Buffer.from(process.argv[4],'base64').toString('utf8'):'';
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{let raw={};try{raw=JSON.parse(input||'{}')}catch{}
const safe={provider,observedAt:new Date().toISOString(),plan:raw?.account?.plan||raw?.plan||raw?.plan_tier||raw?.subscription_type,model:raw?.model?.id||raw?.model?.display_name||raw?.model,context_window:raw?.context_window,rate_limits:raw?.rate_limits||raw?.rateLimits,quota:raw?.quota||raw?.quotas||raw?.quota_summary?.buckets};
try{fs.mkdirSync(require('path').dirname(statePath),{recursive:true});const tmp=statePath+'.tmp';fs.writeFileSync(tmp,JSON.stringify(safe),'utf8');fs.renameSync(tmp,statePath)}catch{}
if(!chain)return;const child=cp.spawn(chain,{shell:true,windowsHide:true,stdio:['pipe','pipe','pipe']});child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);child.stdin.end(input);child.on('exit',code=>process.exitCode=code||0)});`;
  if (!fs.existsSync(scriptPath) || fs.readFileSync(scriptPath, 'utf8') !== source) fs.writeFileSync(scriptPath, source, 'utf8');
  return scriptPath;
}

function bridgeCommand(scriptPath: string, provider: string, statePath: string, original: any) {
  const originalCommand = typeof original === 'string' ? original : String(original?.command || '');
  const encoded = originalCommand ? Buffer.from(originalCommand, 'utf8').toString('base64') : '';
  const executable = process.execPath;
  return `set "ELECTRON_RUN_AS_NODE=1"&& "${executable}" "${scriptPath}" "${provider}" "${statePath}" "${encoded}"`;
}

function isLlmeltStatusline(value: any) {
  return typeof value?.command === 'string' && value.command.includes('statusline-bridge.cjs');
}

function readJson(filePath: string) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {} as Record<string, any>;
  }
}

function writeJsonAtomic(filePath: string, value: any) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.llmelt-${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, filePath);
}
