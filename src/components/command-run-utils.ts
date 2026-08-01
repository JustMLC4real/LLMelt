import type { CommandRun, Message, ToolActivityPhase } from '../providers/types';

export const TOOL_SUMMARY_ERROR_PREFIX = 'Tool summary error:';

export interface LiveToolRun {
  chatId: string;
  requestId?: string;
  anchorMessageId?: string;
  run: CommandRun;
  updatedAt: string;
}

export interface LiveToolActivity {
  id: string;
  chatId: string;
  requestId?: string;
  anchorMessageId?: string;
  phase: ToolActivityPhase;
  label: string;
  detail?: string;
  approvalStatus?: 'pending' | 'approved' | 'denied';
  attempt?: number;
  stopReason?: string;
  tone?: 'running' | 'ok' | 'failed' | 'denied';
  updatedAt: string;
}

export interface CommandRunGroupItem {
  key: string;
  run?: CommandRun;
  live?: boolean;
  toolText?: string;
  file?: FileToolActivity;
  label?: string;
  tone?: 'running' | 'ok' | 'failed' | 'denied';
  phase?: ToolActivityPhase;
  detail?: string;
  approvalStatus?: 'pending' | 'approved' | 'denied';
  attempt?: number;
  stopReason?: string;
  attemptKind?: 'primary' | 'previous-attempt';
}

/** Alleen events van het actuele handmatige verzoek (of Auto-modus) mogen live UI bijwerken. */
export function shouldAcceptLiveRequestEvent(activeRequestId: string | null, eventRequestId?: string) {
  if (!eventRequestId) return false;
  if (/^auto-(?:prompter|responder)-/.test(eventRequestId)) return true;
  return !!activeRequestId && eventRequestId === activeRequestId;
}

/** Een lokale send-listener accepteert nooit een event dat expliciet aan een andere chat hangt. */
export function shouldAcceptOwnedRequestEvent(
  chatId: string,
  requestId: string,
  event: { chatId?: string; requestId?: string },
) {
  return event.requestId === requestId && (!event.chatId || event.chatId === chatId);
}

export interface FileToolActivity {
  kind: 'file-read' | 'file-create' | 'file-edit';
  path: string;
  status: 'read' | 'created' | 'edited' | 'unchanged' | 'failed' | 'denied';
  addLines: number;
  deleteLines: number;
  contentPreview?: string;
  diffPreview?: FileDiffLine[];
  errorText?: string;
}

export interface FileDiffLine {
  type: 'add' | 'remove' | 'context';
  text: string;
}

export interface CommandRunGroup {
  key: string;
  anchorMessageId?: string;
  runs: CommandRunGroupItem[];
  summaryError?: string;
}

export type ToolSummaryStatus = 'ok' | 'error' | 'pending';

export type MessageRenderItem =
  | { type: 'message'; message: Message }
  | { type: 'command-run-group'; key: string; group: CommandRunGroup };

export function parseCommandRun(raw?: string | null): CommandRun | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CommandRun;
    if (!parsed?.id || !parsed.command || !parsed.shell) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function makeToolSummaryErrorContent(message: string) {
  return `${TOOL_SUMMARY_ERROR_PREFIX}\n\n${message.trim()}`;
}

export function parseToolSummaryError(message: Message | string) {
  const content = typeof message === 'string' ? message : message.content;
  if (!content.startsWith(TOOL_SUMMARY_ERROR_PREFIX)) return null;
  return content.slice(TOOL_SUMMARY_ERROR_PREFIX.length).trim();
}

export function isToolOutputMessage(message: Message) {
  return !!parseCommandRun(message.toolRun)
    || !!parseToolSummaryError(message)
    || message.content.startsWith('Command output:')
    || message.content.startsWith('Tool output:');
}

export function isToolIntentMessage(message: Message) {
  return message.role === 'assistant' && /^Ik voer de gevraagde toolstappen uit\b/.test(message.content.trim());
}

export function commandRunGroupLabel(group: CommandRunGroup) {
  return commandRunGroupSummaryLabel(group);
}

export function commandRunGroupSummaryLabel(group: CommandRunGroup) {
  const activeActivity = latestActiveActivity(group);
  if (activeActivity?.phase) {
    return activeActivity.phase === 'planning' && activeActivity.label
      ? activeActivity.label
      : phaseLabel(activeActivity.phase);
  }
  if (group.summaryError) return 'Gestopt';
  const normalized = normalizeActivityGroupOrder(group).runs;
  const primaryItems = normalized.filter((item) => item.attemptKind !== 'previous-attempt' && !item.phase);
  const previousCount = normalized.filter((item) => item.attemptKind === 'previous-attempt').length;
  const files = primaryItems.filter((item) => item.file);
  const commands = primaryItems.filter((item) => item.run);
  const other = primaryItems.filter((item) => !item.file && !item.run);
  const running = commands.some((item) => item.run?.status === 'running');

  const parts: string[] = [];
  if (files.length) parts.push(fileActionSummary(files.map((item) => item.file!)));
  if (commands.length) {
    const verb = running ? 'voert' : 'voerde';
    parts.push(`${verb} ${commands.length} ${commands.length === 1 ? 'opdracht' : 'opdrachten'} uit`);
  }
  if (!parts.length && other.length) {
    const count = other.length;
    parts.push(`Verwerkte ${count} ${count === 1 ? 'toolresultaat' : 'toolresultaten'}`);
  }

  const base = parts.length ? capitalizeFirst(joinSummaryParts(parts)) : 'Voerde 1 opdracht uit';
  return previousCount ? `${base} · ${previousCount} eerdere ${previousCount === 1 ? 'poging' : 'pogingen'}` : base;
}

export function commandRunItemLabel(run: CommandRun) {
  return `Heeft uitgevoerd: ${run.command}`;
}

export function commandRunStatusLabel(run: CommandRun, now = Date.now()) {
  if (run.status === 'running') return formatDuration(Math.max(0, now - new Date(run.startedAt).getTime()));
  if (run.status === 'denied') return 'geweigerd';
  if (run.exitCode !== null) return `Afsluitcode ${run.exitCode}`;
  return run.status;
}

export function commandRunTone(run: CommandRun): 'running' | 'ok' | 'failed' | 'denied' {
  if (run.status === 'running') return 'running';
  if (run.status === 'denied') return 'denied';
  if (run.status === 'failed' || (run.exitCode !== null && run.exitCode !== 0)) return 'failed';
  return 'ok';
}

export function commandRunGroupTone(group: CommandRunGroup): 'running' | 'ok' | 'failed' {
  if (group.runs.some((item) => item.run?.status === 'running' || isActivePhase(item.phase))) return 'running';
  const primaryRuns = group.runs.filter((item) => item.attemptKind !== 'previous-attempt');
  if (group.summaryError || primaryRuns.some((item) => {
    if (item.run) return ['failed', 'denied'].includes(commandRunTone(item.run));
    return item.tone === 'failed' || item.tone === 'denied';
  })) return 'failed';
  return 'ok';
}

export function parseToolOutputActivity(message: Message | string): CommandRunGroupItem | null {
  const content = typeof message === 'string' ? message : message.content;
  if (!content.startsWith('Tool output:') && !content.startsWith('Command output:')) return null;
  const body = content.replace(/^(?:Tool output|Command output):\s*/i, '').trim();
  if (!body) return null;

  const firstLine = body.split(/\r?\n/)[0]?.trim() || 'tool output';
  const failed = /\[(?:error|invalid file payload|geen wijziging|geweigerd)\]|Traceback|Error:|Exception|failed|niet gevonden|No such file|overgeslagen/i.test(body);
  const denied = /\[geweigerd|geweigerd door gebruiker/i.test(body);
  const skipped = /Command overgeslagen/i.test(body);
  const runMatch = firstLine.match(/^\$?\s*(?:run\s+)?(.+)/i);
  const fileMatch = firstLine.match(/^(file-read|file-create|file-edit)\s+(.+)$/i);
  const file = fileMatch && shouldRenderFileReview(body, failed, denied)
    ? parseFileToolActivity(body, fileMatch[1] as 'file-read' | 'file-create' | 'file-edit', fileMatch[2].trim(), failed, denied)
    : undefined;
  let label: string;

  if (denied) {
    const what = fileMatch ? `${fileMatch[1]} ${fileMatch[2]}`.trim() : (runMatch ? runMatch[1].trim() : firstLine);
    label = `Geweigerd: ${what}`;
  } else if (skipped && runMatch) {
    label = `Heeft overgeslagen: ${runMatch[1].trim()}`;
  } else if (fileMatch) {
    label = file ? fileToolLineLabel(file) : fileToolOutputLabel(body, fileMatch[1] as 'file-read' | 'file-create' | 'file-edit', fileMatch[2].trim());
  } else if (firstLine.startsWith('$')) {
    label = `Heeft uitgevoerd: ${firstLine.replace(/^\$\s*/, '')}`;
  } else {
    label = `Heeft uitgevoerd: ${firstLine}`;
  }

  const id = typeof message === 'string' ? body : message.id;
  return {
    key: `tool-output-${id}`,
    toolText: body,
    file,
    label,
    tone: denied ? 'denied' : failed ? 'failed' : 'ok',
  };
}

/** Zet een native bestandstool om naar dezelfde bestand/diffkaart als de tag-toolroute. */
export function commandRunFileActivity(run: CommandRun, key = `native-file-${run.id}`): CommandRunGroupItem | null {
  if (run.status === 'running') return null;
  const output = [run.stdout, run.stderr].filter(Boolean).join('\n').trim();
  const parsed = output ? parseToolOutputActivity(`Tool output:\n\n${output}`) : null;
  if (parsed?.file) {
    return {
      ...parsed,
      key,
      tone: commandRunTone(run),
      toolText: output,
    };
  }

  if (!run.toolKind?.startsWith('file-') || !run.toolPath || run.status !== 'completed') return null;
  const kind = run.toolKind as FileToolActivity['kind'];
  const status: FileToolActivity['status'] = kind === 'file-read' ? 'read' : kind === 'file-edit' ? 'edited' : 'created';
  const file: FileToolActivity = {
    kind,
    path: run.toolPath,
    status,
    addLines: 0,
    deleteLines: 0,
  };
  return {
    key,
    file,
    toolText: output || `${run.toolName || run.command} ${run.toolPath}`,
    label: fileToolLineLabel(file),
    tone: 'ok',
  };
}

function shouldRenderFileReview(body: string, failed: boolean, denied: boolean) {
  if (denied || failed) return false;
  if (/\[geen wijziging\]/i.test(body)) return false;
  return true;
}

function parseFileToolActivity(
  body: string,
  kind: 'file-read' | 'file-create' | 'file-edit',
  filePath: string,
  failed: boolean,
  denied: boolean,
): FileToolActivity {
  const contentPreview = extractSection(body, 'bestandsinhoud');
  const diffPreview = parseDiffPreview(extractSection(body, 'wijziging'));
  const bodyWithoutPreview = body.replace(/\r?\n--- bestandsinhoud ---\r?\n[\s\S]*$/i, '').trim();
  const status: FileToolActivity['status'] = denied
    ? 'denied'
    : failed
      ? 'failed'
      : /\bexists unchanged\b|\[geen wijziging\]/i.test(body)
        ? 'unchanged'
        : kind === 'file-read'
          ? 'read'
          : kind === 'file-edit'
            ? 'edited'
            : 'created';
  const addedDiffLines = diffPreview.filter((line) => line.type === 'add').length;
  const removedDiffLines = diffPreview.filter((line) => line.type === 'remove').length;
  const lineCount = contentPreview ? countMeaningfulLines(contentPreview) : 0;
  return {
    kind,
    path: filePath,
    status,
    addLines: status === 'read' || status === 'unchanged' ? 0 : addedDiffLines || (status === 'created' ? lineCount : estimateAddedLines(body, lineCount)),
    deleteLines: removedDiffLines,
    contentPreview,
    diffPreview: diffPreview.length ? diffPreview : undefined,
    errorText: status === 'failed' || status === 'denied'
      ? bodyWithoutPreview.split(/\r?\n/).slice(1).join('\n').trim()
      : undefined,
  };
}

function fileToolLineLabel(file?: FileToolActivity) {
  if (!file) return 'Bestand bewerkt';
  if (file.status === 'denied') return `Niet uitgevoerd: ${humanFileAction(file)} ${file.path}`;
  if (file.status === 'failed') return `Heeft geprobeerd: ${humanFileAction(file)} ${file.path}`;
  if (file.status === 'unchanged') return `Ongewijzigd: ${file.path}`;
  return `Heeft uitgevoerd: ${humanFileAction(file)} ${file.path}`;
}

function fileToolOutputLabel(body: string, kind: 'file-read' | 'file-create' | 'file-edit', filePath: string) {
  if (/\[geweigerd|geweigerd door gebruiker/i.test(body)) return `Geweigerd: ${kind} ${filePath}`;
  if (/\[geen wijziging\]/i.test(body)) return `Geen wijziging: ${filePath}`;
  if (/\bexists unchanged\b/i.test(body)) return `Ongewijzigd: ${filePath}`;
  const action = kind === 'file-read' ? 'Bestand niet gelezen' : kind === 'file-create' ? 'Bestand niet gemaakt' : 'Bestand niet bewerkt';
  return `${action}: ${filePath}`;
}

function humanFileAction(file: FileToolActivity) {
  if (file.kind === 'file-read') return 'bestand lezen';
  return file.kind === 'file-create' ? 'bestand maken' : 'bestand bewerken';
}

function extractSection(body: string, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = body.match(new RegExp(`\\r?\\n--- ${escaped} ---\\r?\\n([\\s\\S]*?)(?=\\r?\\n--- [^-\\r\\n]+ ---\\r?\\n|$)`, 'i'));
  return match ? match[1].trimEnd() : undefined;
}

function parseDiffPreview(section?: string): FileDiffLine[] {
  if (!section) return [];
  return section.replace(/\r\n/g, '\n').split('\n').map((line) => {
    if (line.startsWith('+')) return { type: 'add' as const, text: line.slice(1) };
    if (line.startsWith('-')) return { type: 'remove' as const, text: line.slice(1) };
    return { type: 'context' as const, text: line.replace(/^ /, '') };
  });
}

function countMeaningfulLines(text: string) {
  if (!text) return 0;
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.length === 1 && lines[0] === '') return 0;
  return lines.length;
}

function estimateAddedLines(body: string, fallback: number) {
  const edited = body.match(/\bedited\b[^\r\n]*\(([+-]\d+)\s+chars\)/i);
  if (!edited) return fallback;
  const delta = Number.parseInt(edited[1], 10);
  if (!Number.isFinite(delta) || delta <= 0) return 0;
  return Math.max(1, fallback ? Math.min(fallback, Math.ceil(delta / 40)) : Math.ceil(delta / 40));
}

export function formatDuration(ms: number) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
}

export function upsertLiveToolRun(list: LiveToolRun[], next: LiveToolRun) {
  const found = list.some((item) => sameLiveToolRun(item, next.chatId, next.requestId, next.run.id));
  if (found) {
    return list.map((item) => (
      sameLiveToolRun(item, next.chatId, next.requestId, next.run.id) ? { ...item, ...next } : item
    ));
  }
  return [...list, next];
}

export function upsertLiveToolActivity(list: LiveToolActivity[], next: LiveToolActivity) {
  const found = list.some((item) => sameLiveToolActivity(item, next.chatId, next.requestId, next.id));
  if (found) {
    return list.map((item) => (
      sameLiveToolActivity(item, next.chatId, next.requestId, next.id) ? { ...item, ...next } : item
    ));
  }
  return [...list, next];
}

export function appendLiveToolRunOutput(
  list: LiveToolRun[],
  owner: { chatId: string; requestId?: string },
  runId: string,
  stream: 'stdout' | 'stderr',
  delta: string,
  updatedAt: string,
) {
  return list.map((item) => {
    if (!sameLiveToolRun(item, owner.chatId, owner.requestId, runId)) return item;
    return {
      ...item,
      updatedAt,
      run: {
        ...item.run,
        [stream]: `${item.run[stream] || ''}${delta || ''}`,
      },
    };
  });
}

export function removeLiveToolRuns(list: LiveToolRun[], runIds: Set<string>, chatId?: string) {
  if (!runIds.size) return list;
  return list.filter((item) => (
    (chatId !== undefined && item.chatId !== chatId) || !runIds.has(item.run.id)
  ));
}

function sameLiveToolRun(item: LiveToolRun, chatId: string, requestId: string | undefined, runId: string) {
  return item.chatId === chatId && item.requestId === requestId && item.run.id === runId;
}

function sameLiveToolActivity(item: LiveToolActivity, chatId: string, requestId: string | undefined, activityId: string) {
  return item.chatId === chatId && item.requestId === requestId && item.id === activityId;
}

export function buildMessageRenderItems(
  messages: Message[],
  liveRuns: LiveToolRun[],
  chatId: string | null,
  liveActivities: LiveToolActivity[] = [],
): MessageRenderItem[] {
  const persistedRunIds = new Set(messages.map((message) => parseCommandRun(message.toolRun)?.id).filter(Boolean) as string[]);
  const groups = new Map<string, CommandRunGroup>();
  const groupOrder: string[] = [];
  const unanchoredKeys = new Set<string>();
  let lastNormalMessageId: string | undefined;
  let lastGroupKey: string | undefined;

  const ensureGroup = (key: string, anchorMessageId?: string) => {
    let group = groups.get(key);
    if (!group) {
      group = { key, anchorMessageId, runs: [] };
      groups.set(key, group);
      groupOrder.push(key);
      if (!anchorMessageId) unanchoredKeys.add(key);
    }
    return group;
  };

  for (const message of messages) {
    const summaryError = parseToolSummaryError(message);
    if (summaryError) {
      const key = lastGroupKey || `summary-${message.id}`;
      ensureGroup(key, groups.get(key)?.anchorMessageId).summaryError = summaryError;
      continue;
    }

    const commandRun = parseCommandRun(message.toolRun);
    if (commandRun) {
      const anchorMessageId = commandRun.anchorMessageId || lastNormalMessageId;
      const key = anchorMessageId || `persisted-${message.id}`;
      ensureGroup(key, anchorMessageId).runs.push(
        commandRunFileActivity(commandRun, `persisted-${message.id}`)
          || { key: `persisted-${message.id}`, run: commandRun, live: false },
      );
      lastGroupKey = key;
      continue;
    }

    const toolActivity = parseToolOutputActivity(message);
    if (toolActivity) {
      const key = lastNormalMessageId || lastGroupKey || `tool-${message.id}`;
      ensureGroup(key, lastNormalMessageId).runs.push(toolActivity);
      lastGroupKey = key;
      continue;
    }

    if (!isToolOutputMessage(message)) lastNormalMessageId = message.id;
  }

  for (const item of liveRuns) {
    if (chatId && item.chatId !== chatId) continue;
    if (persistedRunIds.has(item.run.id)) continue;
    const anchorMessageId = item.anchorMessageId || item.run.anchorMessageId || undefined;
    const key = anchorMessageId || `live-${item.run.id}`;
    ensureGroup(key, anchorMessageId).runs.push(
      commandRunFileActivity(item.run, `live-${item.run.id}`)
        || { key: `live-${item.run.id}`, run: item.run, live: true },
    );
  }

  for (const activity of liveActivities) {
    if (chatId && activity.chatId !== chatId) continue;
    // Modelvoortgang staat in de beurtkop. Alleen echte acties, approvals en fouten
    // horen in het uitklapbare activiteitenoverzicht.
    if (isModelProgressPhase(activity.phase)) continue;
    const anchorMessageId = activity.anchorMessageId || undefined;
    const effectiveAnchorMessageId = anchorMessageId || lastNormalMessageId;
    const key = effectiveAnchorMessageId || lastGroupKey || `activity-${activity.id}`;
    const group = ensureGroup(key, effectiveAnchorMessageId);
    if (!shouldRenderLiveActivity(activity, group)) continue;
    group.runs.push({
      key: `activity-${activity.id}`,
      toolText: activity.detail || activity.label,
      label: activity.label,
      tone: activity.tone || toneForPhase(activity.phase),
      phase: activity.phase,
      detail: activity.detail,
      approvalStatus: activity.approvalStatus,
      attempt: activity.attempt,
      stopReason: activity.stopReason,
      attemptKind: 'primary',
    });
    lastGroupKey = key;
  }

  for (const key of groupOrder) {
    const group = groups.get(key);
    if (group) groups.set(key, normalizeActivityGroupOrder(group));
  }

  const out: MessageRenderItem[] = [];
  const emittedGroups = new Set<string>();

  for (const message of messages) {
    if (parseCommandRun(message.toolRun) || parseToolSummaryError(message) || isToolOutputMessage(message)) continue;
    out.push({ type: 'message', message });
    const group = groups.get(message.id);
    if (group && (group.runs.length || group.summaryError)) {
      out.push({ type: 'command-run-group', key: `group-${group.key}`, group });
      emittedGroups.add(group.key);
    }
  }

  for (const key of groupOrder) {
    const group = groups.get(key);
    if (!group || emittedGroups.has(key) || (!group.runs.length && !group.summaryError)) continue;
    if (unanchoredKeys.has(key) || group.anchorMessageId) out.push({ type: 'command-run-group', key: `group-${group.key}`, group });
  }

  return out;
}

function latestActiveActivity(group: CommandRunGroup): CommandRunGroupItem | null {
  return [...group.runs].reverse().find((item) => isActivePhase(item.phase)) || null;
}

function isActivePhase(phase?: ToolActivityPhase) {
  return phase === 'planning'
    || phase === 'approval_pending'
    || phase === 'running'
    || phase === 'sending_output'
    || phase === 'summarizing'
    || phase === 'repairing';
}

function shouldRenderLiveActivity(activity: LiveToolActivity, group: CommandRunGroup) {
  if (activity.phase === 'approval_approved' || activity.phase === 'done') return false;
  if (activity.phase === 'stopped' && group.summaryError) return false;
  if (activity.phase === 'sending_output' && group.runs.some((item) => item.toolText && !item.phase)) return false;
  return true;
}

function isModelProgressPhase(phase: ToolActivityPhase) {
  return phase === 'planning'
    || phase === 'sending_output'
    || phase === 'summarizing'
    || phase === 'repairing';
}

function phaseLabel(phase: ToolActivityPhase) {
  switch (phase) {
    case 'planning': return 'Model plant toolstappen';
    case 'approval_pending': return 'Wacht op goedkeuring';
    case 'approval_approved': return 'Goedkeuring ontvangen';
    case 'running': return 'Voert opdracht uit';
    case 'sending_output': return 'Verwerkt tool-output';
    case 'summarizing': return 'Model controleert resultaat';
    case 'repairing': return 'Model herstelt fout';
    case 'done': return 'Klaar';
    case 'approval_denied': return 'Gestopt';
    case 'stopped': return 'Gestopt';
    default: return 'Voert opdracht uit';
  }
}

function toneForPhase(phase: ToolActivityPhase): 'running' | 'ok' | 'failed' | 'denied' {
  if (phase === 'approval_denied') return 'denied';
  if (phase === 'stopped') return 'failed';
  if (phase === 'done' || phase === 'approval_approved') return 'ok';
  return 'running';
}

export function normalizeActivityGroupOrder(group: CommandRunGroup): CommandRunGroup {
  const runs = collapseSupersededAttempts(group.runs);
  return {
    ...group,
    runs: [...runs].sort((a, b) => activitySortRank(a) - activitySortRank(b)),
  };
}

export function collapseSupersededAttempts(items: CommandRunGroupItem[]): CommandRunGroupItem[] {
  // Een model kan hetzelfde bestand in meerdere herstelrondes volledig overschrijven.
  // De kaart toont dan alleen de laatste geslaagde toestand als primair resultaat;
  // eerdere versies blijven inspecteerbaar onder "Eerdere pogingen".
  const latestSuccessfulFileIndex = new Map<string, number>();
  items.forEach((item, index) => {
    if (item.attemptKind === 'previous-attempt') return;
    if (!item.file || item.tone === 'failed' || item.tone === 'denied') return;
    if (!['created', 'edited'].includes(item.file.status)) return;
    latestSuccessfulFileIndex.set(normalizePathKey(item.file.path), index);
  });
  const successfulFiles = new Set(
    items
      .filter((item) => item.file && item.tone !== 'failed' && item.tone !== 'denied' && ['created', 'edited'].includes(item.file.status))
      .map((item) => normalizePathKey(item.file!.path)),
  );
  const hasPrimarySuccess = items.some((item) =>
    (item.file && item.tone !== 'failed' && item.tone !== 'denied' && ['created', 'edited'].includes(item.file.status))
    || (item.run && commandRunTone(item.run) === 'ok')
  );

  return items.map((item, index) => {
    if (item.file) {
      const pathKey = normalizePathKey(item.file.path);
      const supersededSuccess = !!pathKey
        && item.attemptKind !== 'previous-attempt'
        && ['created', 'edited'].includes(item.file.status)
        && item.tone !== 'failed'
        && item.tone !== 'denied'
        && latestSuccessfulFileIndex.get(pathKey) !== index;
      return {
        ...item,
        attemptKind: supersededSuccess ? 'previous-attempt' : (item.attemptKind || 'primary'),
      };
    }
    if (item.phase || item.run) return { ...item, attemptKind: item.attemptKind || 'primary' };
    const pathKey = normalizePathKey(extractPathFromToolItem(item));
    const supersededFileAttempt = pathKey && successfulFiles.has(pathKey) && isNoisyToolAttempt(item);
    const noisyAfterSuccess = hasPrimarySuccess && isNoisyToolAttempt(item);
    return {
      ...item,
      attemptKind: supersededFileAttempt || noisyAfterSuccess ? 'previous-attempt' : (item.attemptKind || 'primary'),
    };
  });
}

function activitySortRank(item: CommandRunGroupItem) {
  if (item.phase && item.attemptKind !== 'previous-attempt') return 0;
  if (item.file && item.attemptKind !== 'previous-attempt') return 10;
  if (item.run && item.attemptKind !== 'previous-attempt') return 20;
  if (item.attemptKind !== 'previous-attempt') return 30;
  return 40;
}

function isNoisyToolAttempt(item: CommandRunGroupItem) {
  const text = `${item.label || ''}\n${item.toolText || ''}`;
  return item.tone === 'failed'
    || item.tone === 'denied'
    || /\bGeen wijziging\b|Ongewijzigd|Heeft overgeslagen|\[geen wijziging\]|invalid file payload|Command overgeslagen/i.test(text);
}

function extractPathFromToolItem(item: CommandRunGroupItem) {
  const text = `${item.label || ''}\n${item.toolText || ''}`;
  const fileMatch = text.match(/\b(?:file-read|file-create|file-edit)\s+([^\s\r\n]+)/i);
  if (fileMatch) return fileMatch[1];
  const labelMatch = text.match(/(?:Geen wijziging|Ongewijzigd|Bestand niet gemaakt|Bestand niet bewerkt|Heeft geprobeerd:[^ \r\n]+)\s*:?\s*([^\s\r\n]+)/i);
  return labelMatch?.[1] || '';
}

function normalizePathKey(value?: string) {
  return (value || '').replace(/\\/g, '/').toLowerCase();
}

function fileActionSummary(files: FileToolActivity[]) {
  const count = files.length;
  const noun = count === 1 ? 'bestand' : 'bestanden';
  if (files.every((file) => file.status === 'read')) return `Las ${count} ${noun}`;
  if (files.every((file) => file.status === 'created')) return `Maakte ${count} ${noun}`;
  if (files.every((file) => file.status === 'edited')) return `Bewerkte ${count} ${noun}`;
  return `Wijzigde ${count} ${noun}`;
}

function joinSummaryParts(parts: string[]) {
  if (parts.length <= 1) return parts[0] || '';
  return `${parts.slice(0, -1).join(', ')} en ${parts[parts.length - 1]}`;
}

function capitalizeFirst(value: string) {
  return value ? `${value.charAt(0).toUpperCase()}${value.slice(1)}` : value;
}
