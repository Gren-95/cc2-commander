/** Simple toast notification system */

import { icon, iconSolo } from './icons';

const TOAST_DURATION = 4000;
const MAX_TOASTS = 5;

export type ToastLevel = 'info' | 'success' | 'warning' | 'error';

interface Toast {
  id: number;
  message: string;
  level: ToastLevel;
  timer: ReturnType<typeof setTimeout>;
}

let nextId = 0;
const toasts: Toast[] = [];
let container: HTMLElement | null = null;

function ensureContainer(): HTMLElement {
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.className =
      'toast-container fixed top-14 right-4 z-[1000] flex flex-col gap-2 pointer-events-none max-w-95';
    document.body.appendChild(container);
  }
  return container;
}

function render(): void {
  const el = ensureContainer();
  el.innerHTML = toasts
    .map(
      (t) =>
        `<div class="flex items-center gap-2 [padding:10px_14px] rounded-card bg-card border border-line shadow-card text-[13px] pointer-events-auto [animation:toast-in_0.25s_ease] ${t.level}" data-id="${t.id}">` +
        `<span class="text-[14px] shrink-0">${iconFor(t.level)}</span>` +
        `<span class="flex-1 text-fg">${escapeHtml(t.message)}</span>` +
        `<button class="toast-close bg-transparent border-0 text-fg-muted cursor-pointer text-[12px] [padding:2px_4px] hover:text-fg" aria-label="Dismiss">${iconSolo('close')}</button>` +
        `</div>`,
    )
    .join('');

  el.querySelectorAll('.toast-close').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = parseInt((btn.parentElement as HTMLElement).dataset.id ?? '0');
      dismiss(id);
    });
  });
}

function iconFor(level: ToastLevel): string {
  switch (level) {
    case 'success':
      return icon('ok');
    case 'warning':
      return icon('warning');
    case 'error':
      return icon('error');
    default:
      return icon('info');
  }
}

function escapeHtml(s: string): string {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function dismiss(id: number): void {
  const idx = toasts.findIndex((t) => t.id === id);
  if (idx >= 0) {
    clearTimeout(toasts[idx].timer);
    toasts.splice(idx, 1);
    render();
  }
}

export function toast(message: string, level: ToastLevel = 'info'): void {
  const id = nextId++;
  const timer = setTimeout(() => dismiss(id), TOAST_DURATION);

  toasts.push({ id, message, level, timer });

  // Cap visible toasts
  while (toasts.length > MAX_TOASTS) {
    const old = toasts.shift()!;
    clearTimeout(old.timer);
  }

  render();
}
