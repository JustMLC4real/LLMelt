import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Check,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  Infinity as InfinityIcon,
  type LucideIcon,
} from 'lucide-react';
import { PROVIDER_INFO, type AIModel, type LimitDisplayState, type LimitScope, type ProviderQuotaSnapshot, type ProviderType, type RateLimitSnapshot } from '../providers/types';
import { useProviderStore } from '../stores/provider-store';

export type SelectOption = {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
};

export function IconButton({
  label,
  icon: Icon,
  tone = 'default',
  size = 'md',
  active = false,
  className = '',
  ...buttonProps
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  icon: LucideIcon;
  tone?: 'default' | 'primary' | 'danger';
  size?: 'sm' | 'md';
  active?: boolean;
}) {
  return (
    <button
      type="button"
      {...buttonProps}
      className={`icon-button icon-button-${tone} icon-button-${size} ${active ? 'active' : ''} ${className}`}
      aria-label={label}
      title={buttonProps.title || label}
    >
      <Icon size={size === 'sm' ? 15 : 17} strokeWidth={2} />
    </button>
  );
}

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string; icon?: LucideIcon }>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="segmented-control" role="tablist">
      {options.map((option) => {
        const Icon = option.icon;
        return (
          <button
            key={option.value}
            type="button"
            className={`segment ${value === option.value ? 'active' : ''}`}
            onClick={() => onChange(option.value)}
            role="tab"
            aria-selected={value === option.value}
          >
            {Icon && <Icon size={15} />}
            <span>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export function SelectField({
  value,
  options,
  onChange,
  label,
  placeholder = 'Selecteer...',
  disabled = false,
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  label?: string;
  placeholder?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const fieldId = useId();
  const labelId = `${fieldId}-label`;
  const menuId = `${fieldId}-menu`;
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left: number; width: number; maxHeight: number } | null>(null);
  const selected = options.find((option) => option.value === value);

  const updatePos = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const margin = 8;
    const spaceBelow = window.innerHeight - rect.bottom - margin;
    const spaceAbove = rect.top - margin;
    // Flip the menu above the trigger when there isn't enough room below.
    const openUp = spaceBelow < 240 && spaceAbove > spaceBelow;
    const maxHeight = Math.max(160, Math.min(360, (openUp ? spaceAbove : spaceBelow)));
    setPos({
      left: rect.left,
      width: rect.width,
      maxHeight,
      ...(openUp ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.bottom + 6 }),
    });
  };

  useEffect(() => {
    if (!open) return;
    updatePos();
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const reposition = () => updatePos();
    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    requestAnimationFrame(() => {
      const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value && !option.disabled));
      optionRefs.current[selectedIndex]?.focus();
    });
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [open, options, value]);

  const focusRelativeOption = (direction: 1 | -1) => {
    const enabled = optionRefs.current.filter((option) => option && !option.disabled) as HTMLButtonElement[];
    if (!enabled.length) return;
    const current = enabled.indexOf(document.activeElement as HTMLButtonElement);
    enabled[(current + direction + enabled.length) % enabled.length]?.focus();
  };

  const handleListKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      focusRelativeOption(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const enabled = optionRefs.current.filter((option) => option && !option.disabled) as HTMLButtonElement[];
      enabled[event.key === 'Home' ? 0 : enabled.length - 1]?.focus();
    }
  };

  const choose = (option: SelectOption) => {
    if (option.disabled) return;
    onChange(option.value);
    setOpen(false);
  };

  // Eén (of geen) optie is geen echte keuze. Toon 'm dan als statisch veld
  // i.p.v. een dode/uitgegrijsde dropdown — je ziet de waarde, zonder loos
  // bedieningselement.
  if (options.length <= 1) {
    const only = selected || options[0];
    return (
      <div className="select-field">
        {label && <div id={labelId} className="field-label">{label}</div>}
        <div className="select-trigger select-static">
          <span className={only ? '' : 'select-placeholder'}>{only?.label || placeholder}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="select-field">
      {label && <div id={labelId} className="field-label">{label}</div>}
      <button
        ref={triggerRef}
        type="button"
        className={`select-trigger ${open ? 'open' : ''}`}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault();
            setOpen(true);
          }
          if (event.key === 'Escape') setOpen(false);
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-labelledby={label ? labelId : undefined}
      >
        <span className={selected ? '' : 'select-placeholder'}>{selected?.label || placeholder}</span>
        <ChevronDown size={16} />
      </button>
      {open && !disabled && pos && createPortal(
        <div
          ref={menuRef}
          id={menuId}
          className="select-menu select-menu-portal"
          role="listbox"
          aria-labelledby={label ? labelId : undefined}
          onKeyDown={handleListKeyDown}
          style={{
            position: 'fixed',
            left: pos.left,
            width: pos.width,
            maxHeight: pos.maxHeight,
            overflowY: 'auto',
            // Set BOTH explicitly so the base .select-menu `top: calc(100% + 6px)`
            // can't linger and push the menu off-screen when we anchor by bottom.
            top: pos.top != null ? pos.top : 'auto',
            bottom: pos.bottom != null ? pos.bottom : 'auto',
          }}
        >
          {options.map((option, index) => (
            <button
              ref={(element) => { optionRefs.current[index] = element; }}
              key={option.value || option.label}
              type="button"
              className={`select-option ${option.value === value ? 'active' : ''}`}
              disabled={option.disabled}
              onClick={() => choose(option)}
              role="option"
              aria-selected={option.value === value}
              tabIndex={-1}
            >
              <span>
                <span className="select-option-label">{option.label}</span>
                {option.description && <span className="select-option-description">{option.description}</span>}
              </span>
              {option.value === value && <Check size={15} />}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}

export function ProviderBadge({ provider, label }: { provider: ProviderType; label?: string }) {
  const info = PROVIDER_INFO[provider];
  return (
    <span className="provider-badge" style={{ ['--provider-color' as string]: info?.color || 'var(--accent-cyan)' }}>
      <span className="provider-badge-dot" />
      <span>{label || info?.name || provider}</span>
    </span>
  );
}

export function QuotaBadge({ snapshot, quota, model }: { snapshot?: RateLimitSnapshot; quota?: ProviderQuotaSnapshot; model?: AIModel }) {
  const storedQuotas = useProviderStore((state) => state.quotaSnapshots);
  const resolvedQuota = quota || quotaForModel(model, storedQuotas);
  // Account-brede CLI-providers (Codex, ChatGPT, Claude CLI, Antigravity) hebben
  // een account-limiet; laat die winnen van een generieke/stale snapshot-scope,
  // zodat ze consistent "account-breed" tonen i.p.v. "limiet onbekend"/"bekend na API-call".
  const modelScope = model?.limitScope || inferLimitScope(model);
  const scope = modelScope === 'account' ? 'account' : (snapshot?.limitScope || modelScope);
  const state = resolvedQuota
    ? resolvedQuota.state === 'unlimited' ? 'unlimited' : ['cooldown', 'exhausted'].includes(resolvedQuota.state) ? 'cooldown' : resolvedQuota.state === 'unavailable' ? 'not_exposed' : resolvedQuota.state === 'unknown' ? 'unknown' : 'known'
    : snapshot?.displayState || displayStateFor(scope, snapshot?.known);
  const text = resolvedQuota ? providerQuotaText(resolvedQuota) : quotaText(snapshot, scope, state);
  const Icon = state === 'known' ? CircleCheck : state === 'unlimited' ? InfinityIcon : state === 'cooldown' ? CircleAlert : CircleDashed;

  return (
    <span className={`quota-badge quota-${state}`}>
      <Icon size={13} />
      {text}
    </span>
  );
}

function quotaForModel(model: AIModel | undefined, snapshots: ProviderQuotaSnapshot[]) {
  if (!model) return undefined;
  const group = limitGroupForModel(model);
  return snapshots.find((item) => (
    item.limitGroupKey === group
    || (item.provider === model.provider && (!item.modelId || item.modelId === model.id))
  ));
}

function providerQuotaText(quota: ProviderQuotaSnapshot) {
  if (quota.state === 'unlimited') return 'lokaal';
  if (quota.state === 'unavailable') return 'niet beschikbaar';
  const percentages = quota.buckets.map((bucket) => bucket.remainingFraction).filter((value): value is number => value != null);
  if (percentages.length) return `${Math.round(Math.min(...percentages) * 100)}% over`;
  if (quota.state === 'cooldown' || quota.state === 'exhausted') return 'cooldown';
  return quota.accuracy === 'delayed' ? 'quota vertraagd' : quota.state;
}

export function MotionPanel({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`motion-panel ${className}`}>{children}</div>;
}

export function FlipText({ text, className = '' }: { text: string; className?: string }) {
  // Only animate when the text actually changes after the first mount (i.e. a
  // language switch) \u2014 not every time a component mounts (e.g. opening Settings).
  const prevRef = useRef<string | null>(null);
  const [animating, setAnimating] = useState(false);

  useEffect(() => {
    if (prevRef.current !== null && prevRef.current !== text) {
      setAnimating(true);
      prevRef.current = text;
      const timer = window.setTimeout(() => setAnimating(false), 600);
      return () => window.clearTimeout(timer);
    }
    prevRef.current = text;
  }, [text]);

  return (
    <span key={animating ? `flip-${text}` : text} className={`flip-text ${className}`} aria-label={text}>
      {Array.from(text).map((char, index) => (
        <span
          key={index}
          className={animating ? 'flip-char' : ''}
          style={animating ? { ['--flip-index' as string]: index } : undefined}
          aria-hidden="true"
        >
          {char === ' ' ? '\u00A0' : char}
        </span>
      ))}
    </span>
  );
}

export function limitGroupForModel(model?: AIModel) {
  if (!model) return '';
  if (model.limitGroupKey) return model.limitGroupKey;
  if (model.provider === 'codex') return 'codex:account';
  if (model.provider === 'openai' && model.id.startsWith('chatgpt:')) return 'openai:account';
  if (model.provider === 'anthropic' && model.id.startsWith('claude-cli:')) return 'anthropic:account';
  return `${model.provider}:${model.id}`;
}

function quotaText(snapshot: RateLimitSnapshot | undefined, scope: LimitScope, state: LimitDisplayState) {
  if (state === 'known' && snapshot) {
    if (typeof snapshot.tokensRemaining === 'number' && typeof snapshot.tokensLimit === 'number' && snapshot.tokensLimit > 0) {
      const pct = Math.max(0, Math.round((snapshot.tokensRemaining / snapshot.tokensLimit) * 100));
      return `${pct}% over`;
    }
    if (typeof snapshot.requestsRemaining === 'number') return `${snapshot.requestsRemaining} req over`;
    return 'limiet bekend';
  }
  if (state === 'unlimited') return 'lokaal';
  if (state === 'not_exposed') return scope === 'account' ? 'account-breed' : 'niet exposed';
  if (state === 'cooldown') return 'cooldown';
  if (scope === 'account') return 'account-breed';
  if (scope === 'project') return 'project-limiet';
  if (scope === 'model') return 'bekend na API-call';
  return 'limiet onbekend';
}

function displayStateFor(scope: LimitScope, known?: boolean): LimitDisplayState {
  if (known) return 'known';
  if (scope === 'local') return 'unlimited';
  if (scope === 'account') return 'not_exposed';
  return 'unknown';
}

function inferLimitScope(model?: AIModel): LimitScope {
  if (!model) return 'unknown';
  if (model.provider === 'ollama' || model.provider === 'remote') return 'local';
  if (model.provider === 'codex') return 'account';
  if (model.provider === 'openai' && model.id.startsWith('chatgpt:')) return 'account';
  if (model.provider === 'anthropic' && model.id.startsWith('claude-cli:')) return 'account';
  if (model.provider === 'antigravity') return 'account';
  if (model.provider === 'google') return 'project';
  if (model.provider === 'openai' || model.provider === 'anthropic') return 'model';
  return 'unknown';
}
