import React from 'react';
import { Check, ChevronDown, ChevronRight, Copy, FilePenLine, SquareTerminal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { CommandRun } from '../providers/types';
import {
  type CommandRunGroup,
  type CommandRunGroupItem,
  type FileToolActivity,
  commandRunGroupLabel,
  commandRunGroupTone,
  commandRunItemLabel,
  commandRunStatusLabel,
  commandRunTone,
  formatDuration,
  normalizeActivityGroupOrder,
} from './command-run-utils';
import { copyTextToClipboard } from './clipboard-utils';

export default function CommandRunActivity({ group }: { group: CommandRunGroup }) {
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
  const groupLabel = commandRunGroupLabel(displayGroup);
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
              Samenvatting kon niet worden opgehaald: {group.summaryError}
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
  const groupKey = 'previous-attempts';
  const expanded = expandedKeys.has(groupKey);
  const label = items.length === 1 ? 'Eerdere poging' : `Eerdere pogingen (${items.length})`;
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
      <pre>{item.toolText || '(geen details)'}</pre>
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
  if (files.length > 0 && files.every((file) => file.status === 'read')) {
    return <span className="file-read-stat">gelezen</span>;
  }
  return <DiffStat add={add} del={del} />;
}

function FileStat({ file }: { file: FileToolActivity }) {
  if (file.status === 'read') return <span className="file-read-stat">gelezen</span>;
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
  const tone = item.tone || 'ok';
  const label = item.label || 'Heeft uitgevoerd: tool output';
  const active = tone === 'running' || isActiveActivityPhase(item.phase);
  const meta = [
    item.phase ? phaseText(item.phase) : null,
    item.approvalStatus ? approvalText(item.approvalStatus) : null,
    item.attempt ? `poging ${item.attempt}` : null,
  ].filter(Boolean);
  return (
    <div className={`command-activity-item ${tone}`}>
      <button type="button" className="command-activity-command-line" onClick={onToggle}>
        <span className={active ? 'shimmer' : ''} data-text={label}>{label}</span>
        {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      </button>
      <AnimatedReveal open={expanded}>
        <div className="command-activity-details">
          <div className="command-activity-detail-title">Tool output</div>
          {meta.length > 0 && (
            <div className="command-activity-meta">
              {meta.map((part) => <span key={part}>{part}</span>)}
            </div>
          )}
          <pre className={tone === 'failed' ? 'stderr' : 'stdout'}>{item.toolText || '(geen output)'}</pre>
          {item.stopReason && <pre className="stderr">{item.stopReason}</pre>}
        </div>
      </AnimatedReveal>
    </div>
  );
}

function CommandRunLine({ run, now, expanded, onToggle }: { run: CommandRun; now: number; expanded: boolean; onToggle: () => void }) {
  const tone = commandRunTone(run);
  const label = commandRunItemLabel(run);
  return (
    <div className={`command-activity-item ${tone}`}>
      <button type="button" className="command-activity-command-line" onClick={onToggle}>
        <span className={tone === 'running' ? 'shimmer' : ''} data-text={label}>{label}</span>
        {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      </button>
      <AnimatedReveal open={expanded}>
        <div className="command-activity-details">
          <div className="command-activity-detail-title">Shell</div>
          <pre className="command-activity-command"><span>$ </span>{run.command}</pre>
          <div className="command-activity-meta">
            <span>{run.shell}</span>
            <span title={run.cwd}>{run.cwd}</span>
            <span>{commandRunStatusLabel(run, now)}</span>
            {typeof run.durationMs === 'number' && <span>{formatDuration(run.durationMs)}</span>}
          </div>
          {run.stdout && <pre className="stdout">{run.stdout}</pre>}
          {run.stderr && <pre className="stderr">{run.stderr}</pre>}
          {!run.stdout && !run.stderr && <pre className="muted">(geen output)</pre>}
        </div>
      </AnimatedReveal>
    </div>
  );
}

function phaseText(phase: NonNullable<CommandRunGroupItem['phase']>) {
  switch (phase) {
    case 'planning': return 'Model plant toolstappen';
    case 'approval_pending': return 'Wacht op goedkeuring';
    case 'approval_approved': return 'Goedgekeurd';
    case 'approval_denied': return 'Geweigerd';
    case 'running': return 'Voert uit';
    case 'sending_output': return 'Tool-output verwerkt';
    case 'summarizing': return 'Model vat samen';
    case 'repairing': return 'Model herstelt';
    case 'done': return 'Klaar';
    case 'stopped': return 'Gestopt';
    default: return phase;
  }
}

function approvalText(status: NonNullable<CommandRunGroupItem['approvalStatus']>) {
  if (status === 'pending') return 'approval pending';
  if (status === 'approved') return 'approval approved';
  return 'approval denied';
}

function isActiveActivityPhase(phase?: CommandRunGroupItem['phase']) {
  return phase === 'planning'
    || phase === 'approval_pending'
    || phase === 'running'
    || phase === 'sending_output'
    || phase === 'summarizing'
    || phase === 'repairing';
}
