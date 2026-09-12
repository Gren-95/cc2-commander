/** AI Monitor panel — shows live analysis results and alert history */

import { icon } from './icons';
import { $, escapeHtml, escapeAttr } from './helpers';
import { toast } from './toast';

interface AIIssue {
  type: string;
  description: string;
  confidence: number;
}

interface AIAnalysis {
  timestamp: number;
  source: 'vlm' | 'local' | 'motion';
  status: 'ok' | 'warning' | 'critical';
  confidence: number;
  issues: AIIssue[];
  description: string;
  durationMs: number;
  labelScores?: Array<{ label: string; score: number }>;
}

interface AIAlert {
  timestamp: number;
  status: 'warning' | 'critical';
  issues: AIIssue[];
  description: string;
  consecutiveWarnings: number;
}

const MAX_HISTORY = 30;
const analysisHistory: AIAnalysis[] = [];
const alertHistory: AIAlert[] = [];
let latestVlm: AIAnalysis | null = null;
let latestLocal: AIAnalysis | null = null;
let aiServiceStatus: string = 'disabled';
let aiConfig: Record<string, unknown> | null = null;

/** Update the AI panel with the current service-reported AI status and config */
export function updateAIStatus(status: string, config?: Record<string, unknown> | null): void {
  aiServiceStatus = status;
  if (config) aiConfig = config;
  renderAIPanel();
}

export function handleAIAnalysis(data: Record<string, unknown>): void {
  const analysis: AIAnalysis = {
    timestamp: (data.timestamp as number) || Date.now(),
    source: (data.source as 'vlm' | 'local' | 'motion') || 'vlm',
    status: (data.status as 'ok' | 'warning' | 'critical') || 'ok',
    confidence: (data.confidence as number) || 0,
    issues: (data.issues as AIIssue[]) || [],
    description: (data.description as string) || '',
    durationMs: (data.durationMs as number) || 0,
    labelScores: (data.labelScores as Array<{ label: string; score: number }>) || undefined,
  };

  analysisHistory.unshift(analysis);
  if (analysisHistory.length > MAX_HISTORY) analysisHistory.pop();

  if (analysis.source === 'vlm') latestVlm = analysis;
  else latestLocal = analysis;

  renderAIPanel();
}

export function handleAIAlert(data: Record<string, unknown>): void {
  const alert: AIAlert = {
    timestamp: (data.timestamp as number) || Date.now(),
    status: (data.status as 'warning' | 'critical') || 'warning',
    issues: (data.issues as AIIssue[]) || [],
    description: (data.description as string) || '',
    consecutiveWarnings: (data.consecutiveWarnings as number) || 0,
  };

  alertHistory.unshift(alert);
  if (alertHistory.length > MAX_HISTORY) alertHistory.pop();

  // Show toast for alerts
  // No icon in the message: `toast()` escapes it (so an <i> would show as literal
  // markup) and already draws its own glyph for the level passed below.
  toast(`AI: ${alert.description}`, alert.status === 'critical' ? 'error' : 'warning');

  renderAIPanel();
}

function statusIcon(status: string): string {
  switch (status) {
    case 'ok':
      return icon('ok');
    case 'warning':
      return icon('warning');
    case 'critical':
      return icon('critical');
    default:
      return icon('unknown');
  }
}

function timeAgo(ts: number): string {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  return `${Math.floor(sec / 3600)}h ago`;
}

function renderLabelScores(
  scores: Array<{ label: string; score: number }> | undefined,
  source: string,
): string {
  if (!scores || scores.length === 0) return '';
  // Sort by score descending
  const sorted = [...scores].sort((a, b) => b.score - a.score);
  const rows = sorted
    .map((s) => {
      const pct = Math.round(s.score * 100);
      const barColor =
        pct > 30 ? 'var(--warning)' : pct > 15 ? 'var(--accent)' : 'var(--text-muted)';
      return `<div class="flex items-start [gap:6px] relative text-[0.7rem] min-h-[18px] [padding:2px_0]">
      <div class="absolute left-0 top-0 h-full rounded-[2px] opacity-[0.25] min-w-[2px]" style="width:${Math.max(2, pct)}%;background:${barColor}"></div>
      <span class="w-8 shrink-0 text-right [font-variant-numeric:tabular-nums] text-[var(--text)] z-[1]">${pct}%</span>
      <span class="text-fg-muted z-[1] [word-break:break-word]">${escapeHtml(s.label)}</span>
    </div>`;
    })
    .join('');
  return `<details class="[margin-top:6px] [&_summary]:text-[0.75rem] [&_summary]:text-fg-muted [&_summary]:cursor-pointer [&_summary]:select-none" data-label-source="${source}"><summary>Label scores (${sorted.length})</summary><div class="flex flex-col [gap:3px] mt-1">${rows}</div></details>`;
}

function renderAnalysisCard(a: AIAnalysis): string {
  const issues =
    a.issues.length > 0
      ? a.issues
          .map(
            (i) =>
              `<span class="text-[0.75rem] [padding:2px_6px] rounded-[3px] bg-[var(--bg)] ${a.status}" title="${escapeHtml(i.description)}">${escapeHtml(i.type)} (${Math.round(i.confidence * 100)}%)</span>`,
          )
          .join(' ')
      : '<span class="text-[0.75rem] text-fg-muted">No issues</span>';

  return `
    <div class="[padding:8px_10px] rounded-chip bg-input [margin-bottom:6px] border-l-3 border-line ${a.status}">
      <div class="flex items-center gap-2 text-[0.85rem] mb-1">
        <span>${statusIcon(a.status)}</span>
        <span class="font-semibold text-[var(--text)] text-[0.75rem] [padding:1px_6px] bg-[var(--bg)] rounded-[3px]">${a.source.toUpperCase()}</span>
        <span class="text-[var(--primary)] font-medium">${Math.round(a.confidence * 100)}%</span>
        <span class="text-fg-muted text-[0.75rem] ml-auto">${timeAgo(a.timestamp)}</span>
        <span class="text-fg-muted text-[0.75rem]">${a.durationMs}ms</span>
      </div>
      <div class="text-[0.85rem] text-[var(--text)] mb-1">${escapeHtml(a.description)}</div>
      <div class="flex flex-wrap gap-1">${issues}</div>
      ${renderLabelScores(a.labelScores, a.source)}
    </div>
  `;
}

function renderAlertItem(a: AIAlert): string {
  const issues = a.issues.map((i) => escapeHtml(i.type)).join(', ') || 'unknown';
  return `
    <div class="flex items-center [gap:6px] [padding:6px_10px] text-[0.85rem] bg-input rounded-chip mb-1 border-l-3 border-line ${a.status}">
      <span>${statusIcon(a.status)}</span>
      <span class="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap" title="${escapeAttr(a.description)}">${escapeHtml(a.description)}</span>
      <span class="text-fg-muted text-[0.75rem]">${issues}</span>
      <span class="text-fg-muted text-[0.75rem] ml-auto">${timeAgo(a.timestamp)}</span>
    </div>
  `;
}

export function renderAIPanel(): void {
  const container = $('ai-panel');
  if (!container) return;

  // Preserve <details> open states before re-rendering
  const openStates = new Map<string, boolean>();
  container.querySelectorAll('details[data-label-source]').forEach((el) => {
    const key = (el as HTMLElement).dataset.labelSource ?? '';
    openStates.set(key, (el as HTMLDetailsElement).open);
  });
  const historyOpen = container.querySelector('details.ai-section');
  const historyWasOpen = historyOpen ? (historyOpen as HTMLDetailsElement).open : false;

  // Latest results section
  const latestCards: string[] = [];
  if (latestVlm) latestCards.push(renderAnalysisCard(latestVlm));
  if (latestLocal) latestCards.push(renderAnalysisCard(latestLocal));

  const latestHtml =
    latestCards.length > 0
      ? latestCards.join('')
      : `<div class="text-fg-muted text-[0.85rem] [padding:8px_0]">${aiStatusMessage()}</div>`;

  // Alert history
  const alertHtml =
    alertHistory.length > 0
      ? alertHistory.slice(0, 10).map(renderAlertItem).join('')
      : '<div class="text-fg-muted text-[0.85rem] [padding:8px_0]">No alerts</div>';

  // Recent history (collapsed by default)
  const historyHtml =
    analysisHistory.length > 0
      ? analysisHistory
          .slice(0, 15)
          .map((a) => {
            const t = new Date(a.timestamp).toLocaleTimeString();
            return `<div class="flex items-center [gap:6px] [padding:3px_6px] text-[0.8rem] border-b border-line ${a.status}">
        <span>${statusIcon(a.status)}</span>
        <span class="font-semibold text-[var(--text)] text-[0.75rem] [padding:1px_6px] bg-[var(--bg)] rounded-[3px]">${a.source}</span>
        <span class="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[var(--text)]" title="${escapeAttr(a.description)}">${escapeHtml(a.description)}</span>
        <span class="text-fg-muted text-[0.75rem] ml-auto">${t}</span>
      </div>`;
          })
          .join('')
      : '<div class="text-fg-muted text-[0.85rem] [padding:8px_0]">No history</div>';

  container.innerHTML = `
    <div class="ai-section mb-3 [&_h4]:text-xs font-medium text-fg-muted mb-1.5 [&_summary]:text-xs font-medium text-fg-muted mb-1.5 [&_summary]:cursor-pointer">
      <div class="text-[0.9rem] font-medium text-[var(--text)] mb-2">${aiStatusIcon()} ${aiStatusMessage()}</div>
      ${renderConfigInfo()}
    </div>
    <div class="ai-section mb-3 [&_h4]:text-xs font-medium text-fg-muted mb-1.5 [&_summary]:text-xs font-medium text-fg-muted mb-1.5 [&_summary]:cursor-pointer">
      <h4>Latest Analysis</h4>
      ${latestHtml}
    </div>
    <div class="ai-section mb-3 [&_h4]:text-xs font-medium text-fg-muted mb-1.5 [&_summary]:text-xs font-medium text-fg-muted mb-1.5 [&_summary]:cursor-pointer">
      <h4>Alerts</h4>
      ${alertHtml}
    </div>
    <details class="ai-section mb-3 [&_h4]:text-xs font-medium text-fg-muted mb-1.5 [&_summary]:text-xs font-medium text-fg-muted mb-1.5 [&_summary]:cursor-pointer"${historyWasOpen ? ' open' : ''}>
      <summary>History (${analysisHistory.length})</summary>
      <div class="">${historyHtml}</div>
    </details>
  `;

  // Restore <details> open states for label scores
  container.querySelectorAll('details[data-label-source]').forEach((el) => {
    const key = (el as HTMLElement).dataset.labelSource ?? '';
    if (openStates.get(key)) {
      (el as HTMLDetailsElement).open = true;
    }
  });
}

function aiStatusIcon(): string {
  switch (aiServiceStatus) {
    case 'monitoring':
      return icon('inspect');
    case 'idle':
      return icon('ok');
    case 'stopped':
      return icon('stop');
    default:
      return icon('idle');
  }
}

function aiStatusMessage(): string {
  switch (aiServiceStatus) {
    case 'monitoring':
      return 'Monitoring active — analyzing camera every ' + (aiConfig?.intervalSec ?? '?') + 's';
    case 'idle':
      return 'Enabled — waiting for print to start';
    case 'stopped':
      return 'AI monitor stopped';
    default:
      return 'AI monitoring not enabled';
  }
}

function renderConfigInfo(): string {
  if (!aiConfig || aiServiceStatus === 'disabled') return '';

  const vlm = aiConfig.vlmEnabled
    ? `<span class="text-[#4caf50] font-semibold">${icon('check')} VLM</span> <span class="text-fg-muted text-[0.75rem]">${escapeHtml(String(aiConfig.vlmModel))} @ ${escapeHtml(String(aiConfig.vlmBaseUrl))}</span>`
    : `<span class="text-fg-muted">${icon('cross')} VLM disabled</span>`;

  const local = aiConfig.localEnabled
    ? `<span class="text-[#4caf50] font-semibold">${icon('check')} CLIP</span> <span class="text-fg-muted text-[0.75rem]">${escapeHtml(String(aiConfig.localModel))}${aiConfig.localReady ? '' : ' (loading...)'}</span>`
    : `<span class="text-fg-muted">${icon('cross')} Local CLIP disabled</span>`;

  const interval = `every ${aiConfig.intervalSec}s`;
  const threshold = `alert after ${aiConfig.alertThreshold} warnings`;

  const stats = aiConfig.analysisCount
    ? `<div class="flex items-center [gap:6px] flex-wrap">${icon('reports')} ${aiConfig.analysisCount} analyses performed, ${aiConfig.consecutiveWarnings} consecutive warnings</div>`
    : '';

  return `
    <div class="[padding:8px_10px] bg-input rounded-chip text-[0.8rem] flex flex-col gap-1">
      <div class="flex items-center [gap:6px] flex-wrap">${vlm}</div>
      <div class="flex items-center [gap:6px] flex-wrap">${local}</div>
      <div class="flex items-center [gap:6px] flex-wrap">${icon('duration')} ${interval} · ${threshold}</div>
      ${stats}
    </div>
  `;
}
