import { iconSolo } from './ui/icons';
import { WsClient } from './ws-client';
import { PrinterState } from './printer-state';
import { LogStore } from './log-store';
import { ChartStore } from './chart-store';
import { renderCanvas, setCanvasClient } from './ui/canvas';
import { initCharts, registerChart } from './ui/charts';
import { bindControls, onCommandResponse } from './ui/controls';
import { initPosition3D } from './ui/position-3d';
import { bindDebugPanel, renderDebugPanel, trackStateChanges } from './ui/debug-panel';
import { applyDryerState, handleDryerFinished, setDryerClient } from './ui/dryer-panel';
import { handleEventLog, loadEventLogHistory } from './ui/event-log';
import { initAmbient, renderAmbient } from './ui/ambient';
import { parseDeepLink } from './ui/deep-link';
import { subtabNames, switchSubtab } from './ui/subtabs';
import { currentFileDir, currentFileSource } from './ui/file-browsing';
import { handleInlineThumbnail } from './ui/file-thumbnails';
import { bindFileControls, renderFiles } from './ui/files';
import { bindGcodePreviewControls, renderGcodePreview } from './ui/gcode-preview';
import { fetchTimeout } from './ui/helpers';
import { renderLayerTimeChart } from './ui/layer-chart';
import { bindMaintenanceControls, renderMaintenance, setMaintenanceClient } from './ui/maintenance';
import { handleFileDetailForPrint } from './ui/print-dialog';
import {
  bindHistoryControls,
  renderPrintHistory,
  requestHistory,
  setHistoryClient,
} from './ui/print-history';
import { bindReportControls, renderReports } from './ui/print-reports';
import {
  renderDashboard,
  renderHeader,
  setCameraOverlay,
  syncCameraOverlayControl,
} from './ui/print-status';
import {
  type PrinterLink,
  renderSystemInfo,
  setPrinterLink,
  updateServiceStatus,
} from './ui/service-status';
import { applyCardLayout, getActiveTab, switchToTab } from './ui/settings';
import { bindStructuredLogControls, renderStructuredLog } from './ui/structured-log';
import {
  renderTimelapse,
  requestTimelapseList,
  setTimelapseClient,
  showTimelapsePlayer,
} from './ui/timelapse';
import { toast } from './ui/toast';
import { renderLog, bindLogControls } from './ui/log';
import { installThumbnailFallback } from './ui/helpers';
import { initDashboardEdit } from './ui/dashboard-edit';
import { initSegmented } from './ui/segmented';
import { initSteppers } from './ui/stepper';
import {
  type AuthState,
  fetchAuthState,
  installUnauthorizedHandler,
  login,
  logout,
  renderSignIn,
  setChromeVisible,
} from './ui/auth';
import { initTheme } from './ui/theme';
import { maybeAlertForEvent } from './ui/alert-sound';
import { startTimestampTicker } from './ui/relative-time';
import { createFocusTrap } from './ui/focus-trap';
import type { PrinterStatus, PrinterAttributes, CanvasInfo, FileEntry } from './types';
import {
  COMMAND_METHOD_NAMES,
  classifyCommandOutcome,
  describeCommandError,
  type CommandOutcome,
} from './types';

const state = new PrinterState();
const logStore = new LogStore();
const chartStore = new ChartStore();
let client: WsClient | null = null;
let renderScheduled = false;

// Define chart series
chartStore.defineSeries('nozzle', 'Nozzle', '#ef5350');
chartStore.defineSeries('nozzle_tgt', 'Nozzle Tgt', '#ef535080');
chartStore.defineSeries('bed', 'Bed', '#ffa726');
chartStore.defineSeries('bed_tgt', 'Bed Tgt', '#ffa72680');
chartStore.defineSeries('chamber', 'Chamber', '#66bb6a');
chartStore.defineSeries('fan_model', 'Model', '#4fc3f7');
chartStore.defineSeries('fan_aux', 'Aux', '#66bb6a');
chartStore.defineSeries('fan_case', 'Case', '#ffa726');

// Speed & flow chart series
chartStore.defineSeries('extrusion_rate', 'Extrusion', '#4fc3f7');

// Register charts
registerChart({
  canvasId: 'chart-temps',
  seriesKeys: ['nozzle', 'nozzle_tgt', 'bed', 'bed_tgt', 'chamber'],
  yMin: 0,
  yMax: 300,
  unit: '°',
});

registerChart({
  canvasId: 'chart-fans',
  seriesKeys: ['fan_model', 'fan_aux', 'fan_case'],
  yMin: 0,
  yMax: 100,
  unit: '%',
});

registerChart({
  canvasId: 'chart-speed',
  seriesKeys: ['extrusion_rate'],
  yMin: 0,
  unit: 'mm/s',
  averageKeys: ['extrusion_rate'],
});

function scheduleRender(): void {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    if (client) {
      renderHeader(state);
      renderDashboard(state, client);
      renderCanvas(state);
      renderSystemInfo(state);
      renderTimelapse(state);
      renderGcodePreview(state);
      renderLayerTimeChart(state);
      renderPrintHistory(state);
      renderMaintenance(state);
      renderReports();
      renderLog(logStore);
      renderStructuredLog(logStore);
      renderDebugPanel(state);
    }
  });
}

function $(id: string): HTMLElement {
  return document.getElementById(id)!;
}

/**
 * The printer link now lives in the service-status badge rather than in a pill of its
 * own — see `setPrinterLink`. Kept as a named function because two call sites feed it
 * and the indirection is where the "which of the two connections is this?" question
 * gets answered: this is the PRINTER link, not the browser's socket to the service.
 */
function updateConnectionBadge(status: string): void {
  setPrinterLink(status as PrinterLink);
}

// Subscribe to state changes
state.subscribe(scheduleRender);
state.subscribe(() => trackStateChanges(state));
logStore.subscribe(scheduleRender);

let controlsBound = false;
let dashboardShown = false;

/** Show the dashboard UI and bind controls (idempotent) */
function showDashboard(): void {
  if (dashboardShown) return;
  dashboardShown = true;
  $('connect-dialog').classList.add('hidden');
  // The tab bar, the header controls and the focus rail come back with the dashboard.
  setChromeVisible(true);
  // Before `switchToTab`, whose dashboard branch shows the connect dialog until it sees this.
  $('dashboard').dataset.connected = 'true';
  /*
   * Re-show whatever tab is active rather than the dashboard. This used to be
   * `$('dashboard').classList.remove('hidden')`, and it runs when the socket connects —
   * AFTER startup has already applied `?tab=`. So `?tab=tools` hid the dashboard, then
   * this un-hid it a moment later, and the Tools panel sat below a full dashboard,
   * off-screen. Clicking a tab never showed it, because by then this had already run
   * and it only runs once.
   */
  switchToTab(getActiveTab());
  // `applyCardLayout` runs at startup, while the sign-in card is still up, so the rail
  // it would have drawn was suppressed. Draw it now that there is a session — hiding the
  // element is not enough on its own, because the rail is rebuilt rather than toggled.
  applyCardLayout();

  if (!controlsBound) {
    controlsBound = true;
    bindControls(client!);
    initPosition3D();
    bindLogControls(logStore);
    bindStructuredLogControls(logStore);
    bindFileControls(client!);
    setCanvasClient(client!);
    setDryerClient(client!);
    setTimelapseClient(client!);
    setHistoryClient(client!);
    setMaintenanceClient(client!);
    $('timelapse-refresh').addEventListener('click', () => requestTimelapseList());
    bindHistoryControls();
    bindMaintenanceControls();
    bindReportControls();
    bindGcodePreviewControls();
    bindDebugPanel();
    $('timelapse-close').addEventListener('click', () => {
      const player = $('timelapse-player') as HTMLVideoElement;
      player.pause();
      player.src = '';
      $('timelapse-player-wrap').classList.add('hidden');
    });
    $('btn-reset-layer-data').addEventListener('click', async () => {
      if (!confirm('Reset all layer duration data?')) return;
      try {
        const res = await fetchTimeout('/api/layer-data', { method: 'DELETE' });
        if (res.ok) {
          toast('Layer data reset', 'success');
        } else {
          toast('Reset failed', 'error');
        }
      } catch {
        toast('Network error', 'error');
      }
    });
    initCharts(chartStore);

    // Camera click-to-expand
    const cameraWrap = $('camera-wrap');
    const cameraModal = $('camera-modal');
    const cameraModalImg = $('camera-modal-img') as HTMLImageElement;
    const cameraFeed = $('camera-feed') as HTMLImageElement;
    // ELEG-41. The overlay covers the dashboard but the dashboard stays interactive, so
    // without a trap Tab walks focus onto the move, temperature and stop controls the
    // user cannot see — controls that drive a physical machine. The trap also owns
    // Escape and restores focus to the opener on close.
    let releaseCameraTrap: (() => void) | null = null;

    const closeModal = () => {
      // Guard: the click handler on the overlay fires for the close button too, so this
      // can run twice. Releasing a trap twice would restore focus to the wrong element.
      if (cameraModal.classList.contains('hidden')) return;
      cameraModal.classList.add('hidden');
      cameraModalImg.src = '';
      releaseCameraTrap?.();
      releaseCameraTrap = null;
      // Hide first, then drop out of full screen: the `fullscreenchange` that follows
      // re-enters this function, and the guard above is what stops it looping.
      if (document.fullscreenElement === cameraModal) void document.exitFullscreen();
    };

    /**
     * Show the feed over the whole page, and over the whole *screen* when asked.
     *
     * `requestFullscreen` needs a user gesture and is refused outright by iOS Safari on
     * anything but a `<video>`, so the overlay is the thing that opens and full screen
     * is a request made on top of it. A refusal therefore costs the browser chrome, not
     * the feature.
     */
    const openModal = (fullscreen = false) => {
      // `hidden` is what `updateCamera` actually toggles. The guard used to read
      // `alt === 'Camera off'` — the alt text was never changed off its placeholder,
      // so every enlarge, from the feed and from the button, returned here silently.
      if (!cameraFeed.src || cameraFeed.classList.contains('hidden')) return;
      cameraModalImg.src = cameraFeed.src;
      cameraModal.classList.remove('hidden');
      // Created after `.hidden` is removed: the trap reads the focusable children, and
      // this repo's `.hidden` class is one of the things it treats as not focusable.
      releaseCameraTrap = createFocusTrap(cameraModal, { onEscape: closeModal });
      if (fullscreen) void cameraModal.requestFullscreen?.().catch(() => {});
    };

    // Escape in full screen is taken by the browser to exit it, and never reaches the
    // focus trap — without this, leaving full screen would strand the overlay open over
    // the dashboard and need a second Escape.
    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement) closeModal();
    });

    cameraWrap.addEventListener('click', () => openModal());

    $('camera-modal-close').addEventListener('click', (e) => {
      e.stopPropagation();
      closeModal();
    });
    cameraModal.addEventListener('click', closeModal);

    // The header button goes to full screen; clicking the feed itself opens the same
    // overlay without it, so there is still a way to enlarge the picture that does not
    // take over the display. The button used to toggle a `camera-expanded` class that
    // raised the img to 60vh — inside a grid cell whose width it could not change.
    $('camera-expand-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      openModal(true);
    });

    // Camera overlay switch
    const overlayBox = $('camera-overlay-btn') as HTMLInputElement;
    overlayBox.addEventListener('change', () => setCameraOverlay(overlayBox.checked));
    syncCameraOverlayControl();

    // Camera snapshot download with retry (max 3 attempts, exponential backoff)
    const snapshotBtn = $('camera-snapshot-btn') as HTMLButtonElement;
    snapshotBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (snapshotBtn.disabled) return;
      snapshotBtn.disabled = true;
      snapshotBtn.innerHTML = iconSolo('pending');
      try {
        let res: Response | undefined;
        for (let attempt = 0; attempt < 3; attempt++) {
          if (attempt > 0) {
            snapshotBtn.title = `Retrying (${attempt})`;
            await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
          }
          try {
            res = await fetchTimeout('/api/snapshot');
            if (res.ok) break;
          } catch {
            res = undefined;
          }
        }
        if (!res || !res.ok) {
          toast('Snapshot failed', 'error');
          return;
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        a.download = `snapshot-${ts}.jpg`;
        a.click();
        URL.revokeObjectURL(url);
        toast('Snapshot saved', 'success');
      } catch {
        toast('Snapshot failed', 'error');
      } finally {
        snapshotBtn.disabled = false;
        snapshotBtn.innerHTML = iconSolo('snapshot');
        snapshotBtn.title = 'Save a snapshot';
      }
    });
  }
}

/** Called when printer MQTT is confirmed connected */
function onPrinterConnected(sn: string): void {
  console.log(`Connected to printer SN: ${sn}`);
  toast(`Connected to printer ${sn}`, 'success');
  showDashboard();

  // Request data that the service may not have cached yet
  client!.sendCommand(1044, { storage_media: 'local', dir: '/', offset: 0, limit: 50 });
  client!.sendCommand(1048, { storage_media: 'local' });
  client!.sendCommand(2006, {});
  requestHistory();
}

/**
 * Toast the outcome of a write command, and hand the classification back so a caller
 * with something more specific to say on success can branch on it.
 *
 * Before ELEG-40 a refused command produced nothing at all: `guardedSend` re-enabled the
 * button on its timer and the user reasonably concluded it had worked. `busy` is a
 * warning rather than an error because it is not a failure — the printer simply could
 * not take the command this instant.
 *
 * **Nothing is retried automatically, deliberately.** These are writes to a physical
 * machine, and a re-sent `move` that lands thirty seconds later — after the user has
 * given up and put a hand on the bed — is worse than one that visibly did nothing. The
 * user is told they can press it again; pressing it is theirs to decide.
 */
function reportCommandOutcome(method: number, data: unknown): CommandOutcome {
  const result = (data as Record<string, unknown>).result as Record<string, unknown> | undefined;
  const code = result?.error_code as number | undefined;
  const outcome = classifyCommandOutcome(code);
  const label = COMMAND_METHOD_NAMES[method] ?? `Command ${method}`;

  if (outcome === 'busy') {
    toast(`${label}: printer is busy — try again in a moment`, 'warning');
  } else if (outcome === 'rejected') {
    toast(`${label} refused: ${describeCommandError(code)}`, 'warning');
  } else if (outcome === 'error') {
    toast(`${label} failed: ${describeCommandError(code)}`, 'error');
  }
  return outcome;
}

function connectToService(): void {
  // Build WS URL relative to current page (works with Vite proxy and production)
  const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const serviceUrl = `${wsProtocol}//${location.host}/ws`;

  $('connect-error').textContent = '';
  ($('connect-btn') as HTMLButtonElement).disabled = true;
  ($('connect-btn') as HTMLButtonElement).textContent = 'Connecting...';

  client = new WsClient({
    serviceUrl,
    onStateChange(connState) {
      updateConnectionBadge(connState);

      if (connState === 'disconnected' && dashboardShown) {
        toast('Connection lost — reconnecting...', 'warning');
      }

      if (connState === 'error' && !dashboardShown) {
        ($('connect-btn') as HTMLButtonElement).disabled = false;
        ($('connect-btn') as HTMLButtonElement).textContent = 'Connect';
        // Name the address that failed. "Ensure the service is running" is not actionable
        // when the service IS running somewhere else, or when something else has taken
        // its port — an unrelated nginx container answering on 8088 produces exactly this
        // screen, and without the URL there is nothing to go on.
        $('connect-error').textContent =
          `Cannot reach the CC2 Commander service at ${serviceUrl}. It may not be running, ` +
          'or something else may be listening on that port.';
        toast('Service connection failed', 'error');
      }
    },
    onRegistered(sn, _printerIp) {
      onPrinterConnected(sn);
    },
    onInit(initData) {
      // Hydrate state from service snapshot
      if (initData.status) {
        state.setFullStatus(initData.status as PrinterStatus);
      }
      if (initData.attributes) {
        state.setAttributes(initData.attributes as PrinterAttributes);
      }
      if (initData.canvas) {
        state.setCanvas(initData.canvas as CanvasInfo);
      }
      if (initData.files && Array.isArray(initData.files)) {
        state.setFiles(initData.files as FileEntry[]);
      }
      if (initData.thumbnail) {
        state.thumbnail = initData.thumbnail as string;
      }
      if (initData.fileTotalLayers != null) {
        state.fileTotalLayers = initData.fileTotalLayers as number;
      }
      if (initData.layerTimes && Array.isArray(initData.layerTimes)) {
        const lt = initData.layerTimes as Array<{
          layer: number;
          duration: number;
          timestamp: number;
        }>;
        if (lt.length > 0) {
          const lastEntry = lt[lt.length - 1];
          state.restoreLayerData(lt, lastEntry.layer, lastEntry.timestamp);
        }
      }
      if (initData.filamentUsage && Array.isArray(initData.filamentUsage)) {
        state.filamentUsage = initData.filamentUsage as typeof state.filamentUsage;
      }
      if (initData.zones) {
        state.zones = initData.zones as typeof state.zones;
      }
      if (initData.serviceStatus) {
        updateServiceStatus(initData.serviceStatus as Record<string, unknown>);
      }
      // Load chart history from service (replaces localStorage persistence)
      if (initData.chartHistory && Array.isArray(initData.chartHistory)) {
        chartStore.loadHistory(
          initData.chartHistory as Array<{ t: number; values: Record<string, number> }>,
        );
      }
      // Load event log history
      if (initData.eventLog && Array.isArray(initData.eventLog)) {
        loadEventLogHistory(
          initData.eventLog as Array<{ ts: number; event: Record<string, unknown> }>,
        );
      }

      // Always show dashboard when service responds — even if printer MQTT is down
      showDashboard();
      const printerConnected = initData.connected as boolean;
      if (!printerConnected) {
        updateConnectionBadge('disconnected');
      }
      scheduleRender();
    },
    onMessage(method, data) {
      state.handleResponse(method, data as Record<string, unknown>);
      onCommandResponse(method);

      // Writes report their own failures; reads do not (a poll that comes back busy is
      // re-polled seconds later and is not worth a toast). `ok` for anything unlisted,
      // so the success paths below read the same either way.
      const outcome =
        COMMAND_METHOD_NAMES[method] !== undefined ? reportCommandOutcome(method, data) : 'ok';

      if (method === 1044 && client) {
        requestAnimationFrame(() => renderFiles(state, client!));
      }
      if (method === 1047 && client) {
        // After file delete, refresh file list and capacity
        const result = (data as Record<string, unknown>).result as
          | Record<string, unknown>
          | undefined;
        const errorCode = result?.error_code as number | undefined;
        if (errorCode === 0) {
          toast('File deleted', 'success');
        } else if (classifyCommandOutcome(errorCode) === 'busy') {
          toast('Cannot delete — printer is busy. Try again in a moment.', 'warning');
        } else {
          toast(`Delete failed: ${describeCommandError(errorCode)}`, 'error');
        }
        client.sendCommand(1044, {
          storage_media: currentFileSource(),
          dir: currentFileDir(),
          offset: 0,
          limit: 200,
        });
        client.sendCommand(1048, { storage_media: currentFileSource() });
      }
      if (method === 1048 && client) {
        requestAnimationFrame(() => renderFiles(state, client!));
      }
      if (method === 1045) {
        // 'popup' went with the popover's Preview button — it opened a second floating
        // layer holding the same thumbnail the popover was already showing, and the
        // G-code card renders the actual model. 'print' is handled in printer-state.ts.
        if (state._lastThumbnailPurpose === 'inline') {
          handleInlineThumbnail(state._lastRawThumbnail);
        }
      }
      if (method === 1046) {
        handleFileDetailForPrint(state);
      }
      // After move/home, request fresh status and flash position
      if ((method === 1026 || method === 1027) && client && outcome === 'ok') {
        client.sendCommand(1002, {});
        const pos = state.status?.gcode_move;
        if (pos) {
          const x = pos.x?.toFixed(1) ?? '--';
          const y = pos.y?.toFixed(1) ?? '--';
          const z = pos.z?.toFixed(1) ?? '--';
          toast(`Position: X${x} Y${y} Z${z}`, 'success');
        }
        // Flash the position display
        for (const id of ['pos-x', 'pos-y', 'pos-z']) {
          const el = document.getElementById(id);
          if (el) {
            el.classList.remove('pos-flash');
            void el.offsetWidth; // force reflow
            el.classList.add('pos-flash');
          }
        }
      }
      if (method === 1051) {
        const r1051 = (data as Record<string, unknown>).result as
          | Record<string, unknown>
          | undefined;
        const err1051 = r1051?.error_code as number | undefined;
        if (err1051 === 0) {
          if (state.videoUrl) {
            showTimelapsePlayer(state.videoUrl);
          } else {
            toast('Timelapse export started — video will be generated', 'info');
          }
        } else if (classifyCommandOutcome(err1051) === 'busy') {
          toast('Cannot export timelapse — printer is busy. Try when idle.', 'warning');
          requestAnimationFrame(() => renderTimelapse(state));
        } else {
          toast(`Timelapse export failed: ${describeCommandError(err1051)}`, 'error');
          requestAnimationFrame(() => renderTimelapse(state));
        }
      }
      if (method === 1050 && state.videoUrl) {
        showTimelapsePlayer(state.videoUrl);
      }
      // Only on success. These used to toast "started" whatever came back, so a
      // calibration the printer had refused as busy still read as under way (ELEG-40).
      if (outcome === 'ok') {
        if (method === 1032) {
          toast('Auto-level started', 'success');
        }
        if (method === 1033) {
          toast('Vibration optimization started', 'success');
        }
        if (method === 1034) {
          toast('PID calibration started', 'success');
        }
        if (method === 1035) {
          toast('Self-check started', 'success');
        }
      }
      if (method === 1038) {
        // History delete. 1036 takes no paging params, so the refresh is a full refetch.
        const result = (data as Record<string, unknown>).result as
          | Record<string, unknown>
          | undefined;
        const code = result?.error_code as number | undefined;
        if (classifyCommandOutcome(code) === 'ok') {
          toast('History entry deleted', 'success');
        } else if (classifyCommandOutcome(code) === 'busy') {
          toast('Cannot delete — printer is busy. Try again in a moment.', 'warning');
        } else {
          toast(`Delete failed: ${describeCommandError(code)}`, 'error');
        }
        requestHistory();
      }
      if (method === 1036) {
        requestAnimationFrame(() => renderPrintHistory(state));
        requestAnimationFrame(() => renderTimelapse(state));
      }
      if (method === 2003) {
        const result = (data as Record<string, unknown>).result as
          | Record<string, unknown>
          | undefined;
        const errorCode = result?.error_code as number | undefined;
        if (errorCode === 0) {
          toast('Filament saved', 'success');
          if (client) client.sendCommand(2005, {});
        } else if (classifyCommandOutcome(errorCode) === 'busy') {
          toast('Cannot edit filament while printing — printer is busy', 'warning');
        } else {
          toast(`Filament save failed: ${describeCommandError(errorCode)}`, 'error');
        }
      }
    },
    onStatusEvent(data) {
      state.handleStatusEvent(data as Record<string, unknown>);
      // Auto-refresh timelapse list when video generation completes or fails
      const ms = (data as Record<string, unknown>).result as Record<string, unknown> | undefined;
      const subStatus = (ms?.machine_status as Record<string, unknown>)?.sub_status as
        | number
        | undefined;
      if (subStatus === 3021 || subStatus === 3022) {
        // Timelapse generation complete/failed — refresh history to get updated URLs
        toast(
          subStatus === 3021 ? 'Timelapse video ready' : 'Timelapse export failed',
          subStatus === 3021 ? 'success' : 'error',
        );
        requestTimelapseList();
      }
    },
    onRawMessage(direction, topic, data) {
      logStore.add(direction, topic, data);
    },
    onServiceStatus(data) {
      updateServiceStatus(data);
    },
    onChartData(t, values) {
      chartStore.pushPoint(t, values);
    },
    onDryerState(data) {
      applyDryerState(data);
    },
    onHomeAssistant(data) {
      renderAmbient(data);
    },
    onDryerFinished(reason, label) {
      handleDryerFinished(reason, label);
    },
    onEventLog(entry) {
      handleEventLog(entry);
      // ELEG-46. This is the LIVE event path; `loadEventLogHistory` below restores the
      // history on connect and deliberately does NOT sound, so reconnecting never
      // replays a sound for a print that finished an hour ago.
      maybeAlertForEvent(entry.event);
    },
    onLayerTime(entry) {
      state.addLayerTime(entry);
    },
    onLayerClear() {
      state.clearLayerTimes();
    },
    onFilamentUsage(usage) {
      state.filamentUsage = usage;
      scheduleRender();
    },
    onZoneChange(data) {
      state.zones.previous = data.from as typeof state.zones.current;
      state.zones.current = data.to as typeof state.zones.current;
      state.zones.enteredAt = data.timestamp;
      if (state.zones.history.length > 50) state.zones.history.shift();
      state.zones.history.push({
        zone: data.from as typeof state.zones.current,
        entered: 0,
        exited: data.timestamp,
      });
      scheduleRender();
    },
  });

  client.connect();

  // Wire auto-report gap detection: request full status on missed sequence IDs
  state.setRefreshCallback(() => {
    client?.sendCommand(1002, {});
  });
}

/**
 * Sign in, then connect.
 *
 * The two are one action from the user's side — the button says "Sign in" and the
 * dashboard appears — but they are separate over the wire: a password buys a session
 * cookie, and the WebSocket upgrade then carries that cookie like any same-origin
 * request. A service with no password configured skips straight to the connect.
 */
let authState: AuthState = { required: false, authenticated: true };

async function signInThenConnect(): Promise<void> {
  const button = $('connect-btn') as HTMLButtonElement;
  const errorEl = $('connect-error');
  errorEl.textContent = '';

  if (authState.required && !authState.authenticated) {
    const field = $('auth-password') as HTMLInputElement;
    const password = field.value;
    if (!password) {
      errorEl.textContent = 'Enter the service password.';
      return;
    }
    button.disabled = true;
    button.textContent = 'Signing in…';
    const outcome = await login(password);
    button.disabled = false;
    button.textContent = 'Sign in';
    if (!outcome.ok) {
      errorEl.textContent = outcome.message;
      field.select();
      return;
    }
    // Never leave the password in a field that survives in the DOM.
    field.value = '';
    authState = { ...authState, authenticated: true };
    $('btn-sign-out')?.classList.remove('hidden');
  }

  connectToService();
}

$('connect-btn').addEventListener('click', () => {
  void signInThenConnect();
});

// Enter submits, because a single password field that needs a mouse is a small insult.
$('auth-password')?.addEventListener('keydown', (event) => {
  if ((event as KeyboardEvent).key === 'Enter') void signInThenConnect();
});

$('btn-sign-out')?.addEventListener('click', () => {
  void logout().then(() => location.reload());
});

/**
 * Decide, before anything else runs, whether to show the dashboard or the sign-in card.
 *
 * A session that is already valid connects with no interaction, so the common case —
 * reopening the tab — looks exactly as it did before auth existed.
 */
async function boot(): Promise<void> {
  installUnauthorizedHandler();
  authState = await fetchAuthState();
  // Only when there is a session to end: on the sign-in card it would be a button
  // that signs you out of nothing.
  $('btn-sign-out')?.classList.toggle('hidden', !(authState.required && authState.authenticated));
  if (authState.authenticated) {
    connectToService();
    return;
  }
  // Nothing but the sign-in card until there is a session: no tab bar, no focus rail,
  // no header controls. They navigate nowhere useful, and on a phone the rail sits over
  // the card and clips the password field.
  setChromeVisible(false);
  renderSignIn(authState);
}

initDashboardEdit();
initSegmented();
void initAmbient();

// Open whatever `?tab=` and `?subtab=` ask for. Read ONCE, at startup: the URL is an
// address, not a channel the app watches — see ui/deep-link.ts.
{
  const link = parseDeepLink(location.search, subtabNames);
  if (link.tab) switchToTab(link.tab);
  if (link.group && link.subtab) switchSubtab(link.group, link.subtab);
}
initSteppers();

void boot();

// A corrupt or truncated thumbnail otherwise renders as the browser's broken-image
// icon. One delegated listener covers every thumbnail, including the ones built as
// HTML strings (ELEG-42).
installThumbnailFallback();

// Re-assert the stored theme (the inline script in index.html already set it before
// paint) and follow the OS while the choice is "auto" (ELEG-34).
initTheme();
// ELEG-45. Rewrites the text of existing timestamp spans once a second; it does NOT
// re-render the logs, so the auto-scroll, the pause button and expanded rows are all
// unaffected. A no-op while the setting is off.
startTimestampTicker();

// Auto-connect is now `boot()` above: it asks whether a password is required before
// opening a socket that would only be refused.

// Ship uncaught client errors to server for logging
function reportClientError(
  message: string,
  stack?: string,
  url?: string,
  line?: number,
  col?: number,
): void {
  try {
    navigator.sendBeacon('/api/client-error', JSON.stringify({ message, stack, url, line, col }));
  } catch {
    /* ignore */
  }
}
window.addEventListener('error', (e) => {
  reportClientError(e.message, e.error?.stack, e.filename, e.lineno, e.colno);
});
window.addEventListener('unhandledrejection', (e) => {
  const msg = e.reason instanceof Error ? e.reason.message : String(e.reason);
  const stack = e.reason instanceof Error ? e.reason.stack : undefined;
  reportClientError(msg, stack);
});

// Tab navigation
document.querySelectorAll('.main-tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    // No 'debug' here any more — it is a section of the About page, not a tab.
    // `switchToTab` still accepts it, for callers that deep-link to the debug view.
    const tab = (btn as HTMLElement).dataset.tab as 'dashboard' | 'settings' | 'tools' | 'help';
    switchToTab(tab);
  });
});

// Apply saved card layout
applyCardLayout();

/*
 * The sidebar resize handle and toggle used to live here — about 55 lines of drag
 * maths plus two localStorage keys (`elegoo-web-sidebar-width`,
 * `elegoo-web-sidebar-hidden`, named before the rename). Both went with the sidebar itself: the dashboard is one
 * grid now and a card's width is a per-card setting rather than a property of which
 * rail it happened to be in. The stale keys are harmless if still in storage; nothing
 * reads them.
 */

// ---- PWA service worker ----
//
// Registration is deliberately late and failure is deliberately silent: the dashboard
// works perfectly without a worker, and a browser that refuses one (private mode, an
// insecure origin that is not localhost) must not lose the app over it.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker
    .register('/sw.js')
    .then((registration) => {
      /*
       * Tell the user a new build is cached — do NOT reload for them.
       *
       * This page is usually left open watching a 14-hour print. Swapping it out from
       * under someone mid-job to pick up a CSS change is the wrong trade, so the update
       * is announced and applied on their next reload.
       */
      registration.addEventListener('updatefound', () => {
        const installing = registration.installing;
        if (!installing) return;
        installing.addEventListener('statechange', () => {
          // `controller` is null on the very first install; that is a fresh visit, not
          // an update, and saying "updated" there would be nonsense.
          if (installing.state === 'installed' && navigator.serviceWorker.controller) {
            toast('A new version is ready — reload to use it', 'info');
          }
        });
      });
    })
    .catch(() => {
      // Non-critical; see above.
    });
}
