"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import clsx from "clsx";
import { X } from "lucide-react";

export function Switch({
  checked,
  onChange,
  label,
  disabled,
  tone = "settled",
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
  tone?: "settled" | "signal";
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-40",
        checked
          ? tone === "signal"
            ? "border-signal bg-signal"
            : "border-settled bg-settled"
          : "border-rule bg-[#E3E8EF]",
      )}
    >
      <span
        className={clsx(
          "inline-block h-3.5 w-3.5 rounded-full bg-white shadow-[0_1px_2px_rgba(19,35,63,0.35)] transition-transform",
          checked ? "translate-x-[18px]" : "translate-x-[2px]",
        )}
      />
    </button>
  );
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
  size = "md",
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (next: T) => void;
  label: string;
  size?: "sm" | "md";
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-md border border-rule bg-paper p-0.5">
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={String(opt.value)}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(opt.value)}
            className={clsx(
              "rounded-[5px] font-medium transition-colors",
              size === "sm" ? "px-2 py-0.5 text-xs" : "px-3 py-1 text-sm",
              active ? "bg-panel text-ink shadow-[0_0_0_1px_#D5DCE5]" : "text-ink-soft hover:text-ink",
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

export function Dialog({
  open,
  title,
  description,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className="w-[min(28rem,calc(100vw-2rem))] rounded-md border border-rule bg-panel p-0 text-ink shadow-[0_24px_60px_-20px_rgba(19,35,63,0.45)] backdrop:bg-ink/40"
    >
      {open && (
        <div className="p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 id={titleId} className="text-lg font-semibold leading-tight">
                {title}
              </h2>
              {description && <p className="mt-1 text-sm leading-relaxed text-ink-soft">{description}</p>}
            </div>
            <button type="button" onClick={onClose} aria-label="Close" className="rounded p-1 text-ink-faint hover:text-ink">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="mt-4">{children}</div>
        </div>
      )}
    </dialog>
  );
}

export interface ToastMessage {
  id: number;
  text: string;
  tone: "neutral" | "signal";
}

export function Toasts({ items, onDismiss }: { items: ToastMessage[]; onDismiss: (id: number) => void }) {
  return (
    <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4">
      {items.map((t) => (
        <div
          key={t.id}
          className={clsx(
            "pointer-events-auto flex items-center gap-3 rounded-md px-4 py-2.5 text-sm font-medium text-white shadow-lg",
            t.tone === "signal" ? "bg-signal" : "bg-ink",
          )}
        >
          <span>{t.text}</span>
          <button type="button" onClick={() => onDismiss(t.id)} aria-label="Dismiss" className="opacity-70 hover:opacity-100">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}

export function PanelHeader({
  title,
  titleId,
  description,
  actions,
}: {
  title: string;
  titleId?: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 border-b border-rule px-4 py-3 sm:px-5">
      <div className="min-w-0">
        <h2 id={titleId} className="text-[15px] font-semibold leading-tight">
          {title}
        </h2>
        {description && <p className="mt-0.5 text-[13px] text-ink-soft">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
