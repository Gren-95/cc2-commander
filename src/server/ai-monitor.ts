/**
 * AI Print Monitor — analyzes camera frames during prints to detect failures.
 *
 * Two analysis paths, neither of which carries a dependency:
 *   1. Motion — frame-to-frame pixel diff via sharp, always on. This is what catches a
 *      stalled print, which a still image cannot show.
 *   2. VLM (Vision Language Model) — an OpenAI-compatible API (Ollama, OpenAI), opt-in
 *      via AI_VLM_ENABLED and off by default.
 *
 * A third backend used to sit here: local CLIP/SigLIP zero-shot classification through
 * @huggingface/transformers. It was removed because the arithmetic never worked out —
 * ~530 MB of node_modules (onnxruntime ships prebuilt binaries for every platform and
 * accelerator, ~90% of which cannot run on any one host) plus a 149 MB model download,
 * to score a dim enclosure webcam against nine hand-tuned sentences. The printer does
 * its own failure detection, and did it better.
 *
 * Results are stored in a ring buffer and exposed via events.
 * Consecutive warnings trigger alerts sent to Telegram and WS clients.
 */

import { EventEmitter } from 'events';
import type { ServiceConfig } from './config.js';
import type { StateStore, PrintEvent } from './state-store.js';
import { getSnapshot } from './rest-api.js';
import sharp from 'sharp';
import { getLogger } from './logger.js';

const log = getLogger('AI');

// ---- Types ----

export interface AIIssue {
  type: string;
  description: string;
  confidence: number;
}

export interface AIAnalysis {
  timestamp: number;
  source: 'vlm' | 'motion';
  status: 'ok' | 'warning' | 'critical';
  confidence: number;
  issues: AIIssue[];
  description: string;
  durationMs: number;
}

export interface AIAlert {
  timestamp: number;
  status: 'warning' | 'critical';
  issues: AIIssue[];
  description: string;
  consecutiveWarnings: number;
}

/** Chart data point emitted with each analysis cycle */
export interface AIChartData {
  t: number;
  motion: number; // 0-100 percentage
}

/** Threshold for motion % below which the printer is considered "not moving" */
const MOTION_STALL_THRESHOLD = 0.5;
/** How many consecutive low-motion readings before we flag print_stalled */
const MOTION_STALL_COUNT = 3;

// ---- Motion Detector (sharp-based pixel diff) ----

const MOTION_WIDTH = 160;
const MOTION_HEIGHT = 120;

class MotionDetector {
  private prevFrame: Buffer | null = null;

  /** Compare current frame to previous, returns motion percentage 0-100 */
  async detect(jpeg: Buffer): Promise<number> {
    // Convert to small grayscale buffer for fast comparison
    const current = await sharp(jpeg)
      .resize(MOTION_WIDTH, MOTION_HEIGHT, { fit: 'fill' })
      .grayscale()
      .raw()
      .toBuffer();

    if (!this.prevFrame || this.prevFrame.length !== current.length) {
      this.prevFrame = current;
      return 0;
    }

    // Count pixels that differ beyond threshold
    const threshold = 25; // ~10% of 255
    let diffCount = 0;
    const total = current.length;
    for (let i = 0; i < total; i++) {
      if (Math.abs(current[i] - this.prevFrame[i]) > threshold) {
        diffCount++;
      }
    }

    this.prevFrame = current;
    return (diffCount / total) * 100;
  }

  reset(): void {
    this.prevFrame = null;
  }
}

// ---- VLM Prompt ----

const VLM_SYSTEM_PROMPT = `You are a 3D print quality monitor. Analyze the camera image of a running FDM 3D printer and detect any print failures or issues.

Respond with ONLY valid JSON matching this schema:
{
  "status": "ok" | "warning" | "critical",
  "confidence": 0.0 to 1.0,
  "issues": [
    { "type": "<issue_type>", "description": "<brief description>", "confidence": 0.0 to 1.0 }
  ],
  "description": "<one sentence summary of what you see>"
}

Issue types to check for:
- spaghetti: filament extruding into air, tangled mess of filament
- bed_adhesion: print detached from build plate, shifted or knocked over
- layer_shift: visible misalignment between layers
- blob: large blob of melted plastic accumulating
- under_extrusion: gaps, holes, or missing sections in print walls
- warping: corners or edges lifting from bed
- stringing: thin strings of filament between parts
- nozzle_clog: no filament coming out despite movement
- print_stalled: no visible progress or movement
- other: any other defect not listed above

If everything looks normal, return status "ok" with an empty issues array.
Be conservative — only flag issues you're confident about. Minor cosmetic issues are "warning", print-threatening issues are "critical".`;

const VLM_USER_PROMPT = 'Analyze this 3D print camera image for print quality issues:';

// ---- VLM Analyzer ----

async function analyzeWithVlm(jpeg: Buffer, config: ServiceConfig): Promise<AIAnalysis> {
  const start = Date.now();
  const base64 = jpeg.toString('base64');
  const isOllama = config.aiVlmProvider === 'ollama';

  try {
    // Build request body — Ollama and OpenAI use different image formats
    const body = isOllama
      ? {
          model: config.aiVlmModel,
          messages: [
            { role: 'system', content: VLM_SYSTEM_PROMPT },
            { role: 'user', content: VLM_USER_PROMPT, images: [base64] },
          ],
          stream: false,
          options: { temperature: 0.1 },
        }
      : {
          model: config.aiVlmModel,
          messages: [
            { role: 'system', content: VLM_SYSTEM_PROMPT },
            {
              role: 'user',
              content: [
                { type: 'text', text: VLM_USER_PROMPT },
                {
                  type: 'image_url',
                  image_url: {
                    url: `data:image/jpeg;base64,${base64}`,
                    detail: 'low',
                  },
                },
              ],
            },
          ],
          max_tokens: 500,
          temperature: 0.1,
        };

    // Build endpoint URL
    const endpoint = isOllama
      ? `${config.aiVlmBaseUrl}/api/chat`
      : `${config.aiVlmBaseUrl}/chat/completions`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (config.aiVlmApiKey) {
      headers['Authorization'] = `Bearer ${config.aiVlmApiKey}`;
    }

    const controller = new AbortController();
    // Ollama can be slow, especially on first request (model loading) — 120s timeout
    const timeoutMs = isOllama ? 120_000 : 30_000;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`VLM API ${res.status}: ${errText.slice(0, 200)}`);
    }

    const data = (await res.json()) as Record<string, unknown>;

    // Extract content — Ollama uses data.message.content, OpenAI uses data.choices[0].message.content
    let content: string;
    if (isOllama) {
      const msg = data.message as { content?: string } | undefined;
      content = msg?.content ?? '';
    } else {
      const choices = data.choices as Array<{ message?: { content?: string } }> | undefined;
      content = choices?.[0]?.message?.content ?? '';
    }

    // Extract JSON from response (may have markdown fences)
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error(`VLM returned non-JSON: ${content.slice(0, 200)}`);
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      status?: string;
      confidence?: number;
      issues?: AIIssue[];
      description?: string;
    };

    return {
      timestamp: start,
      source: 'vlm',
      status: (parsed.status as 'ok' | 'warning' | 'critical') || 'ok',
      confidence: parsed.confidence ?? 0.5,
      issues: parsed.issues ?? [],
      description: parsed.description ?? content.slice(0, 200),
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const msg = (err as Error).message;
    log.warn(`VLM analysis failed: ${msg}`);
    return {
      timestamp: start,
      source: 'vlm',
      status: 'ok',
      confidence: 0,
      issues: [],
      description: `VLM error: ${msg.slice(0, 100)}`,
      durationMs: Date.now() - start,
    };
  }
}

// ---- Main Monitor ----

const MAX_HISTORY = 100;

export class AIMonitor extends EventEmitter {
  private analysisHistory: AIAnalysis[] = [];
  private motionDetector = new MotionDetector();
  private timer: ReturnType<typeof setInterval> | null = null;
  private isPrinting = false;
  private consecutiveWarnings = 0;
  private consecutiveLowMotion = 0;
  private lastAlertTime = 0;
  private _running = false;

  constructor(
    private store: StateStore,
    private config: ServiceConfig,
  ) {
    super();

    // Listen for print state changes
    store.on('print_event', (event: PrintEvent) => {
      if (event.type === 'print_started') {
        this.onPrintStarted();
      } else if (event.type === 'print_completed' || event.type === 'print_failed') {
        this.onPrintEnded();
      }
    });
  }

  private onPrintStarted(): void {
    log.info('Print started — beginning monitoring');
    this.isPrinting = true;
    this.consecutiveWarnings = 0;
    this.consecutiveLowMotion = 0;
    this.motionDetector.reset();
    this.startAnalysisLoop();
  }

  private onPrintEnded(): void {
    log.info('Print ended — stopping monitoring');
    this.isPrinting = false;
    this.stopAnalysisLoop();
  }

  private startAnalysisLoop(): void {
    if (this.timer) return;
    // Run first analysis after a short delay (let print settle)
    setTimeout(() => this.runAnalysis(), 10_000);
    this.timer = setInterval(() => this.runAnalysis(), this.config.aiIntervalSec * 1000);
  }

  private stopAnalysisLoop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async runAnalysis(): Promise<void> {
    if (!this.isPrinting) return;

    // Skip analysis during warmup/heating/filament change — only analyze when actively printing
    const subStatus = this.store.status?.machine_status?.sub_status ?? 0;
    const currentZone = this.store.zones?.current ?? 'outside';
    if (subStatus !== 2075 || currentZone !== 'print_area') {
      // Reset stall counter so filament changes don't accumulate as stall evidence
      this.consecutiveLowMotion = 0;
      log.debug?.(`Skipping analysis — sub_status ${subStatus}, zone ${currentZone}`);
      return;
    }

    const snapshot = await getSnapshot(this.config);
    if (!snapshot) {
      log.warn('No snapshot available for analysis');
      return;
    }

    // Motion detection — always, and the only path that runs without configuration.
    const motion = await this.motionDetector.detect(snapshot);

    // Track consecutive low-motion frames for stall detection
    if (motion < MOTION_STALL_THRESHOLD) {
      this.consecutiveLowMotion++;
    } else {
      this.consecutiveLowMotion = 0;
    }

    const results: AIAnalysis[] = [];

    // Run enabled analyzers in parallel
    const promises: Promise<AIAnalysis>[] = [];

    if (this.config.aiVlmEnabled && (this.config.aiVlmApiKey || this.config.aiVlmBaseUrl)) {
      promises.push(analyzeWithVlm(snapshot, this.config));
    }

    const settled = await Promise.allSettled(promises);
    for (const result of settled) {
      if (result.status === 'fulfilled') {
        results.push(result.value);
        this.analysisHistory.push(result.value);
      }
    }

    // Keep history bounded
    while (this.analysisHistory.length > MAX_HISTORY) {
      this.analysisHistory.shift();
    }

    // Broadcast all results to WS clients
    for (const r of results) {
      this.emit('analysis', r);
      const statusIcon = r.status === 'ok' ? '✅' : r.status === 'warning' ? '⚠️' : '🚨';
      log.info(`${r.source}: ${statusIcon} ${r.description} (${r.durationMs}ms)`);
    }

    // Motion-based stall detection: inject a print_stalled issue if motion
    // has been near-zero for several consecutive cycles while printing
    if (this.consecutiveLowMotion >= MOTION_STALL_COUNT && this.isPrinting) {
      const stallResult: AIAnalysis = {
        timestamp: Date.now(),
        source: 'motion',
        status: 'warning',
        confidence: Math.min(0.9, 0.3 + this.consecutiveLowMotion * 0.1),
        issues: [
          {
            type: 'print_stalled',
            description: `No motion detected for ${this.consecutiveLowMotion} consecutive frames`,
            confidence: Math.min(0.9, 0.3 + this.consecutiveLowMotion * 0.1),
          },
        ],
        description: `Print may be stalled — no motion for ${this.consecutiveLowMotion} frames`,
        durationMs: 0,
      };
      results.push(stallResult);
      this.analysisHistory.push(stallResult);
      this.emit('analysis', stallResult);
      log.info(`motion: ⚠️ ${stallResult.description}`);
    }

    const chartData: AIChartData = {
      t: Date.now(),
      motion: Math.round(motion * 100) / 100,
    };
    this.emit('ai_chart_data', chartData);

    // Determine worst status from this round
    const worstStatus = results.reduce<'ok' | 'warning' | 'critical'>((worst, r) => {
      if (r.status === 'critical') return 'critical';
      if (r.status === 'warning' && worst !== 'critical') return 'warning';
      return worst;
    }, 'ok');

    // Track consecutive warnings/criticals
    if (worstStatus === 'critical') {
      this.consecutiveWarnings += 2; // Critical counts double
    } else if (worstStatus === 'warning') {
      this.consecutiveWarnings++;
    } else {
      this.consecutiveWarnings = Math.max(0, this.consecutiveWarnings - 1); // Decay
    }

    // Check if alert threshold reached
    if (this.consecutiveWarnings >= this.config.aiAlertThreshold) {
      const now = Date.now();
      const cooldown = this.config.aiAlertCooldownSec * 1000;
      if (now - this.lastAlertTime > cooldown) {
        this.lastAlertTime = now;
        const allIssues = results.flatMap((r) => r.issues);
        const alert: AIAlert = {
          timestamp: now,
          status: worstStatus === 'ok' ? 'warning' : worstStatus,
          issues: allIssues,
          description: results.map((r) => r.description).join(' | '),
          consecutiveWarnings: this.consecutiveWarnings,
        };
        log.info(`🚨 ALERT: ${alert.description}`);
        this.emit('alert', alert);
      }
    }
  }

  /** Get recent analysis history */
  getHistory(): AIAnalysis[] {
    return this.analysisHistory;
  }

  /** Get latest analysis per source */
  getLatest(): Record<string, AIAnalysis> {
    const latest: Record<string, AIAnalysis> = {};
    for (let i = this.analysisHistory.length - 1; i >= 0; i--) {
      const a = this.analysisHistory[i];
      if (!latest[a.source]) latest[a.source] = a;
      if (Object.keys(latest).length >= 2) break;
    }
    return latest;
  }

  get isRunning(): boolean {
    return this._running;
  }
  get monitoring(): boolean {
    return this.isPrinting && this.timer !== null;
  }

  /** Config summary for UI display */
  getConfigSummary(): Record<string, unknown> {
    return {
      vlmEnabled: this.config.aiVlmEnabled,
      vlmModel: this.config.aiVlmModel,
      vlmProvider: this.config.aiVlmProvider,
      vlmBaseUrl: this.config.aiVlmBaseUrl,
      intervalSec: this.config.aiIntervalSec,
      alertThreshold: this.config.aiAlertThreshold,
      alertCooldownSec: this.config.aiAlertCooldownSec,
      analysisCount: this.analysisHistory.length,
      consecutiveWarnings: this.consecutiveWarnings,
    };
  }

  async start(): Promise<void> {
    this._running = true;
    log.info('Monitor started');
    log.info(
      `VLM: ${this.config.aiVlmEnabled ? `${this.config.aiVlmModel} @ ${this.config.aiVlmBaseUrl} (${this.config.aiVlmProvider})` : 'disabled'}`,
    );
    log.info(
      `Interval: ${this.config.aiIntervalSec}s, Alert threshold: ${this.config.aiAlertThreshold}`,
    );

    // If printer is already printing when we start, begin monitoring
    const ms = this.store.status?.machine_status?.status;
    if (ms === 2) {
      this.onPrintStarted();
    }
  }

  stop(): void {
    this._running = false;
    this.stopAnalysisLoop();
  }
}
