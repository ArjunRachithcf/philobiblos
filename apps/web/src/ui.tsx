// Small pieces shared by the screens, on HomersLab's components (design/components.css).
import { useEffect, useRef, type ReactNode } from 'react';

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
