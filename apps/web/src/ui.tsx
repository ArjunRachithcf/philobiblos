// Small pieces shared by the screens, on HomersLab's components (design/components.css).
// WCAG 3.2.2 (On Input), for review: a select or text field only sets state (eslint.config.js enforces the handler);
// never let a useEffect on that state save, decide or navigate. Lint cannot see that path; a button or MenuButton acts.
import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';

export function Icon({ name, className = 'icon' }: { name: string; className?: string }) {
  // design/icons.js builds the SVG from its own fixed set of paths; nothing here comes from data.
  return <span aria-hidden="true" style={{ display: 'contents' }} dangerouslySetInnerHTML={{ __html: window.I(name, className) }} />;
}

export function Notice({ kind, title, children }: { kind: 'error' | 'info' | 'ok' | 'warn'; title?: string; children?: ReactNode }) {
  return (
    <div className={`notice notice-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <Icon name={kind === 'error' ? 'alert' : kind === 'ok' ? 'check' : 'info'} />
      <span className="notice-body">{title && <b>{title}</b>}{children && <span>{children}</span>}</span>
    </div>
  );
}

/** Moves focus to the page's heading when a screen opens, so screen readers announce it. */
export function PageHead({ title, sub, actions }: { title: string; sub?: ReactNode; actions?: ReactNode }) {
  const h = useRef<HTMLHeadingElement>(null);
  useEffect(() => { h.current?.focus(); }, [title]);
  return (
    <header className="page-head">
      <div>
        <h1 ref={h} tabIndex={-1}>{title}</h1>
        {sub && <p className="page-sub">{sub}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

export const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';

/** A segmented radio group (manual activation: arrows move focus, Space or Enter chooses). */
export function Choice({ label, value, options, onChange, className = '' }: { label: string; value: string; options: [string, string][]; onChange: (v: string) => void; className?: string }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const chose = useRef<string | null>(null);
  const pos = Math.max(0, options.findIndex(([k]) => k === value));
  useEffect(() => {
    if (chose.current !== value) return; // wait for the saved value (the list may re-sort first)
    chose.current = null;
    // A modal opened by the choice keeps its focus; otherwise focus stays on the control.
    if (!document.querySelector('dialog[open]')) refs.current[pos]?.focus();
  });
  const key = (e: KeyboardEvent, i: number) => {
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1
      : e.key === 'Home' ? -i : e.key === 'End' ? options.length - 1 - i : 0;
    if (!d) return;
    e.preventDefault();
    refs.current[(i + d + options.length) % options.length]?.focus();
  };
  return (
    <div role="radiogroup" aria-label={label} className={`segmented ${className}`} style={{ '--n': options.length, '--pos': pos } as CSSProperties}>
      <span className="segmented-thumb" aria-hidden="true" />
      {options.map(([k, l], i) => (
        <button key={k} ref={(el) => { refs.current[i] = el; }} type="button" role="radio" aria-checked={k === value} tabIndex={k === value ? 0 : -1}
          onClick={() => { if (k !== value) { chose.current = k; onChange(k); } }} onKeyDown={(e) => key(e, i)}>{l}</button>
      ))}
    </div>
  );
}

/**
 * A menu button (ARIA APG): Enter, Space or Arrow Down opens the menu on its first (or checked) item, Arrow Up on its
 * last; arrows, Home and End move; Enter or Space chooses; Escape closes and returns to the button; Tab or a click
 * elsewhere closes. With `checked`, the items are menuitemradio.
 */
export function MenuButton({ label, name, items, onPick, checked, empty = 'Nothing here' }: {
  label: string; name: string; items: { value: string; text: string }[]; onPick: (v: string) => void; checked?: string; empty?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const first = useRef<'first' | 'last'>('first');

  useEffect(() => {
    if (!open) return;
    const i = first.current === 'last' ? Math.max(0, items.length - 1) : Math.max(0, items.findIndex((x) => x.value === checked));
    refs.current[i]?.focus();
    const away = (e: PointerEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]); // focus once, when it opens (not on each new list of items)

  const close = (focus = true) => { setOpen(false); if (focus) button.current?.focus(); };
  const onButtonKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      first.current = e.key === 'ArrowUp' ? 'last' : 'first';
      setOpen(true);
    }
  };
  const onMenuKey = (e: KeyboardEvent, i: number) => {
    const n = items.length;
    const to = e.key === 'ArrowDown' ? (i + 1) % n : e.key === 'ArrowUp' ? (i - 1 + n) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1;
    if (to >= 0) { e.preventDefault(); refs.current[to]?.focus(); return; }
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'Tab') close(false);
  };
  const role = checked === undefined ? 'menuitem' : 'menuitemradio';
  return (
    <div className="bl-menu-wrap" ref={wrap}>
      <button ref={button} type="button" className="btn btn-sm bl-menu-btn" id={`${id}-b`} aria-haspopup="menu" aria-expanded={open}
        aria-controls={`${id}-m`} aria-label={name === label ? undefined : `${name}: ${label}`}
        onClick={() => { first.current = 'first'; setOpen(!open); }} onKeyDown={onButtonKey}>
        {label}<span aria-hidden="true" className="bl-chev">▾</span>
      </button>
      {open && (
        <div className="menu is-open bl-menu" role="menu" id={`${id}-m`} aria-labelledby={`${id}-b`}>
          {/* An empty menu still holds one item (disabled), so it has focus to give and Escape to hear. */}
          {items.length === 0 ? (
            <button ref={(el) => { refs.current[0] = el; }} type="button" role="menuitem" aria-disabled="true" tabIndex={-1} className="menu-item"
              onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } else if (e.key === 'Tab') close(false); else if (e.key !== 'Enter' && e.key !== ' ') e.preventDefault(); }}>
              {empty}
            </button>
          ) : items.map((it, i) => (
            <button key={it.value} ref={(el) => { refs.current[i] = el; }} type="button" role={role} tabIndex={-1} className="menu-item"
              {...(role === 'menuitemradio' ? { 'aria-checked': it.value === checked } : {})}
              onClick={() => { close(); onPick(it.value); }} onKeyDown={(e) => onMenuKey(e, i)}>
              {it.text}{it.value === checked && <span className="sr-only"> (current)</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
