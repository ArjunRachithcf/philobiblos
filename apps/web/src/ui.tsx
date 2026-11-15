// Small pieces shared by the screens, on HomersLab's components (design/components.css).
import { useEffect, useRef, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';

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
