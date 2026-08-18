import React from 'react';
import { Check, ChevronDown, ChevronRight, Copy, FilePenLine, SquareTerminal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { CommandRun } from '../providers/types';
import {
  type CommandRunGroup,
  type CommandRunGroupItem,
  type FileToolActivity,
  commandRunGroupTone,
  commandRunTone,
  formatDuration,
  normalizeActivityGroupOrder,
} from './command-run-utils';
import { copyTextToClipboard } from './clipboard-utils';

export default function CommandRunActivity({ group }: { group: CommandRunGroup }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = React.useState(false);
  const [expandedRuns, setExpandedRuns] = React.useState<Set<string>>(new Set());
  const [now, setNow] = React.useState(() => Date.now());
  const displayGroup = React.useMemo(() => normalizeActivityGroupOrder(group), [group]);
  const tone = commandRunGroupTone(displayGroup);
  const running = tone === 'running';

  React.useEffect(() => {
    if (!running) return undefined;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [running]);

  const toggleRun = (runId: string) => {
    setExpandedRuns((current) => {
      const next = new Set(current);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });
  };
  const groupLabel = localizedCommandRunGroupLabel(displayGroup, t);
  const statusItems = displayGroup.runs.filter((item) => item.phase && item.attemptKind !== 'previous-attempt');
  const fileItems = displayGroup.runs.filter((item) => item.file && item.attemptKind !== 'previous-attempt');
  const commandItems = displayGroup.runs.filter((item) => item.run && item.attemptKind !== 'previous-attempt');
  const toolItems = displayGroup.runs.filter((item) => !item.file && !item.run && !item.phase && item.attemptKind !== 'previous-attempt');
  const previousItems = displayGroup.runs.filter((item) => item.attemptKind === 'previous-attempt');

  return (
    <div className={`command-activity ${tone}`}>
      <button type="button" className="command-activity-heading" onClick={() => setExpanded((value) => !value)}>
        <SquareTerminal size={14} className="command-activity-icon" />
        <span className={`command-activity-label ${running ? 'shimmer' : ''}`} data-text={groupLabel}>{groupLabel}</span>
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>

      <AnimatedReveal open={expanded} className="command-activity-expand">
        <div className="command-activity-list">
          {statusItems.map((item) => (
            <ToolOutputLine
              key={item.key}
              item={item}
              expanded={expandedRuns.has(item.key)}
              onToggle={() => toggleRun(item.key)}
            />
          ))}
          {commandItems.map((item) => item.run ? (
            <CommandRunLine
              key={item.key}
              run={item.run}
              now={now}
              expanded={expandedRuns.has(item.run.id)}
              onToggle={() => toggleRun(item.run!.id)}
            />
          ) : null)}
          {toolItems.map((item) => (
            <ToolOutputLine
              key={item.key}
              item={item}
              expanded={expandedRuns.has(item.key)}
              onToggle={() => toggleRun(item.key)}
            />
          ))}
          {previousItems.length > 0 && (
            <PreviousAttemptsGroup
              items={previousItems}
              expandedKeys={expandedRuns}
              onToggle={toggleRun}
            />
          )}
          {fileItems.length > 0 && (
            <FileActivityGroup
              items={fileItems}
              expandedKeys={expandedRuns}
              onToggle={toggleRun}
            />
          )}
          {group.summaryError && (
            <div className="command-summary-error">
              {t('activity.summaryFailed', { error: group.summaryError })}
            </div>
          )}
        </div>
      </AnimatedReveal>
    </div>
  );
}

function AnimatedReveal({ open, className = '', children }: React.PropsWithChildren<{ open: boolean; className?: string }>) {
  return (
    <div className={`activity-reveal ${open ? 'open' : ''} ${className}`.trim()} aria-hidden={!open}>
      <div className="activity-reveal-inner">{children}</div>
    </div>
  );
}

function PreviousAttemptsGroup({
  items,
  expandedKeys,
  onToggle,
}: {
  items: CommandRunGroupItem[];
  expandedKeys: Set<string>;
  onToggle: (key: string) => void;
}) {
  const { t } = useTranslation();
  const groupKey = 'previous-attempts';
  const expanded = expandedKeys.has(groupKey);
  const label = items.length === 1
    ? t('activity.previousAttempt')
    : t('activity.previousAttempts', { count: items.length });
  return (
    <div className="command-activity-previous">
      <button type="button" className="command-activity-command-line previous" onClick={() => onToggle(groupKey)}>
        <span>{label}</span>
        {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      </button>
      <AnimatedReveal open={expanded}>
        {items.map((item) => item.run ? (
          <CommandRunLine
            key={item.key}
            run={item.run}
            now={Date.now()}
            expanded={expandedKeys.has(item.run.id)}
            onToggle={() => onToggle(item.run!.id)}
          />
        ) : (
          <ToolOutputLine
            key={item.key}
            item={item}
            expanded={expandedKeys.has(item.key)}
            onToggle={() => onToggle(item.key)}
          />
        ))}
      </AnimatedReveal>
    </div>
  );
}

function FileActivityGroup({
  items,
  expandedKeys,
  onToggle,
}: {
  items: CommandRunGroupItem[];
  expandedKeys: Set<string>;
  onToggle: (key: string) => void;
}) {
  const { t } = useTranslation();
  const fileItems = items.filter((item): item is CommandRunGroupItem & { file: FileToolActivity } => !!item.file);
  const totalAdd = fileItems.reduce((sum, item) => sum + item.file.addLines, 0);
  const totalDelete = fileItems.reduce((sum, item) => sum + item.file.deleteLines, 0);
  const hasFailure = fileItems.some((item) => item.tone === 'failed' || item.tone === 'denied' || item.file.status === 'failed' || item.file.status === 'denied');
  const files = fileItems.map((item) => item.file);
  const sectionTitle = files.every((file) => file.status === 'read') ? t('activity.filesRead') : t('activity.filesEdited');

  return (
    <div className={`file-activity-group ${hasFailure ? 'failed' : ''}`}>
      <div className="file-activity-section-heading">
        <FilePenLine size={14} />
        <span>{sectionTitle}</span>
        <FileGroupStat files={files} add={totalAdd} del={totalDelete} />
      </div>

      <div className="file-activity-files">
        {fileItems.map((item) => (
          <div className={`file-activity-file ${item.tone || 'ok'}`} key={item.key}>
            <button type="button" className="file-activity-file-row" onClick={() => onToggle(item.key)}>
              <span className="file-activity-path"><span>{fileActionLabel(item.file, t)}</span> {item.file.path}</span>
              <FileStat file={item.file} />
              {expandedKeys.has(item.key) ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            </button>
            <AnimatedReveal open={expandedKeys.has(item.key)}>
              <FileActivityDetails item={item} />
            </AnimatedReveal>
          </div>
        ))}
      </div>
    </div>
  );
}

function FileActivityDetails({ item }: { item: CommandRunGroupItem & { file: FileToolActivity } }) {
  const { t } = useTranslation();
  const file = item.file;
  const [copied, setCopied] = React.useState(false);
  const copyText = file.diffPreview?.map((line) => `${line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '}${line.text}`).join('\n') || file.contentPreview || item.toolText || '';
  const copyFileText = async () => {
    if (!copyText) return;
    if (!await copyTextToClipboard(copyText)) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  if (file.errorText) {
    return (
      <div className="file-activity-details failed">
        <div className="file-activity-detail-title">{t('common.error')}</div>
        <pre>{file.errorText}</pre>
      </div>
    );
  }

  if (file.contentPreview || file.diffPreview?.length) {
    return (
      <div className="file-activity-details">
        <div className="file-activity-detail-title">{fileDetailTitle(file, t)}</div>
        <div className="file-diff-view">
          <div className="file-diff-header">
            <span>{file.path}</span>
            <FileStat file={file} />
            <button type="button" className="file-diff-copy" onClick={copyFileText} title={t('activity.copy')} aria-label={t('activity.copyFileContent')}>
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </button>
          </div>
          <FileContentLines file={file} />
        </div>
      </div>
    );
  }

  return (
    <div className="file-activity-details">
      <div className="file-activity-detail-title">{t('activity.file')}</div>
      <pre>{item.toolText || t('activity.noDetails')}</pre>
    </div>
  );
}

function FileContentLines({ file }: { file: FileToolActivity }) {
  if (file.diffPreview?.length) {
    let oldLine = 1;
    let newLine = 1;
    return (
      <div className="file-diff-lines">
        {file.diffPreview.map((line, index) => {
          const shownLine = line.type === 'remove' ? oldLine : newLine;
          if (line.type !== 'add') oldLine += 1;
          if (line.type !== 'remove') newLine += 1;
          return (
            <div className={`file-diff-line ${line.type}`} key={`${index}-${line.type}-${line.text}`}>
              <span className="file-diff-line-no">{shownLine}</span>
              <span className="file-diff-line-marker">{line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '}</span>
              <code>{line.text || ' '}</code>
            </div>
          );
        })}
      </div>
    );
  }

  const lines = file.contentPreview?.replace(/\r\n/g, '\n').split('\n') || [];
  const mode = file.status === 'created' ? 'add' : 'context';
  return (
    <div className="file-diff-lines">
      {lines.map((line, index) => (
        <div className={`file-diff-line ${mode}`} key={`${index}-${line}`}>
          <span className="file-diff-line-no">{index + 1}</span>
          <span className="file-diff-line-marker">{mode === 'add' ? '+' : ' '}</span>
          <code>{line || ' '}</code>
        </div>
      ))}
      {!lines.length && (
        <div className="file-diff-line context">
          <span className="file-diff-line-no">1</span>
          <span className="file-diff-line-marker"> </span>
          <code> </code>
        </div>
      )}
    </div>
  );
}

function FileGroupStat({ files, add, del }: { files: FileToolActivity[]; add: number; del: number }) {
  const { t } = useTranslation();
  if (files.length > 0 && files.every((file) => file.status === 'read')) {
    return <span className="file-read-stat">{t('activity.readStat')}</span>;
  }
  return <DiffStat add={add} del={del} />;
}

function FileStat({ file }: { file: FileToolActivity }) {
  const { t } = useTranslation();
  if (file.status === 'read') return <span className="file-read-stat">{t('activity.readStat')}</span>;
  return <DiffStat add={file.addLines} del={file.deleteLines} />;
}

function DiffStat({ add, del }: { add: number; del: number }) {
  if (!add && !del) return <span className="diff-stat empty">0</span>;
  return (
    <span className="diff-stat">
      {add > 0 && <span className="diff-add">+{add}</span>}
      {del > 0 && <span className="diff-del">-{del}</span>}
    </span>
  );
}

function fileActionLabel(file: FileToolActivity, t: TFunction) {
  if (file.status === 'read') return t('activity.read');
  if (file.status === 'created') return t('activity.created');
  if (file.status === 'edited') return t('activity.edited');
  if (file.status === 'unchanged') return t('activity.unchanged');
  if (file.status === 'denied') return t('activity.denied');
  return t('activity.failed');
}

function fileDetailTitle(file: FileToolActivity, t: TFunction) {
  if (file.status === 'read') return t('activity.readFile');
  if (file.status === 'created') return t('activity.createdFile');
  if (file.status === 'unchanged') return t('activity.unchangedFile');
  if (file.status === 'failed') return t('activity.editFailed');
  return t('activity.editedFile');
}

function ToolOutputLine({ item, expanded, onToggle }: { item: CommandRunGroupItem; expanded: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  const tone = item.tone || 'ok';
  const label = item.label || t('activity.defaultToolLabel');
  const active = tone === 'running' || isActiveActivityPhase(item.phase);
  const meta = [
    item.phase ? phaseText(item.phase, t) : null,
    item.approvalStatus ? approvalText(item.approvalStatus, t) : null,
    item.attempt ? t('activity.attempt', { count: item.attempt }) : null,
  ].filter(Boolean);
  return (
    <div className={`command-activity-item ${tone}`}>
      <button type="button" className="command-activity-command-line" onClick={onToggle}>
        <span className={active ? 'shimmer' : ''} data-text={label}>{label}</span>
        {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      </button>
      <AnimatedReveal open={expanded}>
        <div className="command-activity-details">
          <div className="command-activity-detail-title">{t('activity.toolOutput')}</div>
          {meta.length > 0 && (
            <div className="command-activity-meta">
              {meta.map((part) => <span key={part}>{part}</span>)}
            </div>
          )}
          <pre className={tone === 'failed' ? 'stderr' : 'stdout'}>{item.toolText || t('activity.noOutput')}</pre>
          {item.stopReason && <pre className="stderr">{item.stopReason}</pre>}
        </div>
      </AnimatedReveal>
    </div>
  );
}

function CommandRunLine({ run, now, expanded, onToggle }: { run: CommandRun; now: number; expanded: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  const tone = commandRunTone(run);
  const label = t('activity.executedCommand', { command: run.command });
  return (
    <div className={`command-activity-item ${tone}`}>
      <button type="button" className="command-activity-command-line" onClick={onToggle}>
        <span className={tone === 'running' ? 'shimmer' : ''} data-text={label}>{label}</span>
        {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      </button>
      <AnimatedReveal open={expanded}>
        <div className="command-activity-details">
          <div className="command-activity-detail-title">{t('activity.shell')}</div>
          <pre className="command-activity-command"><span>$ </span>{run.command}</pre>
          <div className="command-activity-meta">
            <span>{run.shell}</span>
            <span title={run.cwd}>{run.cwd}</span>
            <span>{localizedCommandRunStatusLabel(run, now, t)}</span>
            {typeof run.durationMs === 'number' && <span>{formatDuration(run.durationMs)}</span>}
          </div>
          {run.stdout && <pre className="stdout">{run.stdout}</pre>}
          {run.stderr && <pre className="stderr">{run.stderr}</pre>}
          {!run.stdout && !run.stderr && <pre className="muted">{t('activity.noOutput')}</pre>}
        </div>
      </AnimatedReveal>
    </div>
  );
}

function phaseText(phase: NonNullable<CommandRunGroupItem['phase']>, t: TFunction) {
  return t(`activity.phase.${phase}`);
}

function approvalText(status: NonNullable<CommandRunGroupItem['approvalStatus']>, t: TFunction) {
  return t(`activity.approval.${status}`);
}

export function localizedCommandRunStatusLabel(run: CommandRun, now: number, t: TFunction) {
  if (run.status === 'running') return formatDuration(Math.max(0, now - new Date(run.startedAt).getTime()));
  if (run.status === 'denied') return t('activity.denied');
  if (run.exitCode !== null) return t('activity.exitCode', { code: run.exitCode });
  return run.status === 'completed' ? t('activity.phase.done') : t('activity.failed');
}

export function localizedCommandRunGroupLabel(group: CommandRunGroup, t: TFunction) {
  const activeActivity = [...group.runs].reverse().find((item) => isActiveActivityPhase(item.phase));
  if (activeActivity?.phase) {
    return activeActivity.phase === 'planning' && activeActivity.label
      ? activeActivity.label
      : phaseText(activeActivity.phase, t);
  }
  if (group.summaryError) return t('activity.phase.stopped');

  const normalized = normalizeActivityGroupOrder(group).runs;
  const primaryItems = normalized.filter((item) => item.attemptKind !== 'previous-attempt' && !item.phase);
  const previousCount = normalized.filter((item) => item.attemptKind === 'previous-attempt').length;
  const files = primaryItems.filter((item) => item.file).map((item) => item.file!);
  const commands = primaryItems.filter((item) => item.run);
  const other = primaryItems.filter((item) => !item.file && !item.run);
  const running = commands.some((item) => item.run?.status === 'running');

  const parts: string[] = [];
  if (files.length) parts.push(localizedFileActionSummary(files, t));
  if (commands.length) {
    parts.push(t(
      commands.length === 1
        ? running ? 'activity.group.runningCommandOne' : 'activity.group.completedCommandOne'
        : running ? 'activity.group.runningCommandMany' : 'activity.group.completedCommandMany',
      { count: commands.length },
    ));
  }
  if (!parts.length && other.length) {
    parts.push(t(other.length === 1 ? 'activity.group.toolResultOne' : 'activity.group.toolResultMany', { count: other.length }));
  }

  const base = capitalizeFirstLocalized(parts.length === 2
    ? t('activity.group.join', { first: parts[0], last: parts[1] })
    : parts[0] || t('activity.group.completedCommandOne', { count: 1 }));
  if (!previousCount) return base;
  return t(previousCount === 1 ? 'activity.group.withPreviousOne' : 'activity.group.withPreviousMany', {
    base,
    count: previousCount,
  });
}

function localizedFileActionSummary(files: FileToolActivity[], t: TFunction) {
  const key = files.every((file) => file.status === 'read')
    ? 'read'
    : files.every((file) => file.status === 'created')
      ? 'created'
      : files.every((file) => file.status === 'edited')
        ? 'edited'
        : 'changed';
  return t(`activity.group.${key}${files.length === 1 ? 'FileOne' : 'FileMany'}`, { count: files.length });
}

function capitalizeFirstLocalized(value: string) {
  return value ? `${value.charAt(0).toUpperCase()}${value.slice(1)}` : value;
}

function isActiveActivityPhase(phase?: CommandRunGroupItem['phase']) {
  return phase === 'planning'
    || phase === 'approval_pending'
    || phase === 'running'
    || phase === 'sending_output'
    || phase === 'summarizing'
    || phase === 'repairing';
}
