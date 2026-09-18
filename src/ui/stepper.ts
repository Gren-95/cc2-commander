/**
 * Custom steppers for every `input[type=number]`.
 *
 * The browser's own spinner is two 8px arrows stacked inside the field. They are
 * unhittable on a touchscreen, they appear only on hover in Chrome, they are absent
 * entirely on iOS, and they look different in every browser — which is the one thing a
 * design system is for. This replaces them with a bordered group: minus, the field,
 * plus.
 *
 * ## Enhancement, not markup
 *
 * Applied at runtime rather than written into the twenty call sites, because half of
 * them live inside `innerHTML` templates that re-render wholesale — the spool calculator
 * rebuilds its whole form on every keystroke. Markup would have to be kept in step by
 * hand in four files; a MutationObserver cannot fall behind.
 *
 * The input element is **moved**, never recreated, so every listener already bound to it
 * survives and the id stays put. Enhancing twice is a no-op.
 *
 * ## The buttons dispatch both events
 *
 * `input` for anything watching keystrokes and `change` for anything that commits — the
 * fan sliders draw that distinction deliberately (live label on `input`, one command on
 * `change`), and a stepper that fired only one of them would be invisible to half the
 * app.
 */

/** Delay before a held button starts repeating, and the gap between repeats. */
const REPEAT_DELAY_MS = 400;
const REPEAT_EVERY_MS = 70;

const GROUP =
  'stepper inline-flex items-stretch overflow-hidden rounded-lg border border-line bg-input focus-within:border-accent';

const BTN = [
  'stepper-btn shrink-0 select-none px-2',
  'text-fg-muted cursor-pointer bg-transparent border-0',
  'text-[13px] leading-none font-medium',
  'transition-colors hover:bg-hover hover:text-fg',
  'disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent',
  'pointer-coarse:px-3',
].join(' ');

/** What the input keeps once the group carries its frame. */
const FIELD_INSIDE = [
  'bg-transparent border-0 text-center',
  '[appearance:textfield]',
  '[&::-webkit-outer-spin-button]:appearance-none',
  '[&::-webkit-inner-spin-button]:appearance-none',
  '[&::-webkit-inner-spin-button]:m-0',
  'focus:outline-none',
].join(' ');

/** The frame utilities that move from the input to the group. */
const FRAME = ['rounded-lg', 'border', 'border-line', 'bg-input', 'focus:border-accent'];

function decimalsOf(step: number): number {
  const s = String(step);
  return s.includes('.') ? s.split('.')[1].length : 0;
}

/** Move the value by one step, clamped, and tell the app twice. */
function nudge(input: HTMLInputElement, direction: 1 | -1): void {
  const step = Number(input.step) || 1;
  const min = input.min === '' ? Number.NEGATIVE_INFINITY : Number(input.min);
  const max = input.max === '' ? Number.POSITIVE_INFINITY : Number(input.max);

  // An empty field steps from `min` when there is one, so the first press on a blank
  // box gives the smallest legal value rather than NaN or a surprising 0.
  const current =
    input.value === '' ? (Number.isFinite(min) ? min - step : 0) : Number(input.value);
  if (!Number.isFinite(current)) return;

  const next = Math.min(max, Math.max(min, current + step * direction));
  input.value = next.toFixed(decimalsOf(step));

  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  syncDisabled(input);
}

/**
 * Pull a typed value back into `[min, max]` once the field is left, at the step's
 * precision. `min`/`max`/`step` stop the +/- buttons from ever leaving the range, but
 * they do nothing to a value the keyboard typed directly — a number input still accepts
 * `-5` in a field whose min is 0, and only refuses to submit it inside a `<form>`, which
 * none of these fields are in. An empty field is left alone: several forms use it as a
 * meaningful "unset" state, and clamping it to `min` would invent a value nobody chose.
 */
function clampTyped(input: HTMLInputElement): void {
  if (input.value === '') return;
  const n = Number(input.value);
  if (!Number.isFinite(n)) return;

  const step = Number(input.step) || 1;
  const min = input.min === '' ? Number.NEGATIVE_INFINITY : Number(input.min);
  const max = input.max === '' ? Number.POSITIVE_INFINITY : Number(input.max);
  const clamped = Math.min(max, Math.max(min, n));
  if (clamped === n) return;

  input.value = clamped.toFixed(decimalsOf(step));
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

/** Grey the button that cannot do anything, so a clamped field says so. */
function syncDisabled(input: HTMLInputElement): void {
  const group = input.closest('.stepper');
  if (!group) return;
  const value = Number(input.value);
  const min = input.min === '' ? Number.NEGATIVE_INFINITY : Number(input.min);
  const max = input.max === '' ? Number.POSITIVE_INFINITY : Number(input.max);
  const [dec, inc] = group.querySelectorAll<HTMLButtonElement>('.stepper-btn');
  if (dec) dec.disabled = Number.isFinite(value) && value <= min;
  if (inc) inc.disabled = Number.isFinite(value) && value >= max;
}

function makeButton(input: HTMLInputElement, direction: 1 | -1): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = BTN;
  btn.textContent = direction === 1 ? '+' : '−';
  btn.setAttribute('aria-label', `${direction === 1 ? 'Increase' : 'Decrease'} ${label(input)}`);
  // Keep focus in the field: pressing a stepper should not steal it, or the next
  // keystroke goes nowhere and the focus-within border flickers off.
  btn.addEventListener('mousedown', (e) => e.preventDefault());

  let timer: ReturnType<typeof setTimeout> | null = null;
  let repeat: ReturnType<typeof setInterval> | null = null;
  const stop = () => {
    if (timer) clearTimeout(timer);
    if (repeat) clearInterval(repeat);
    timer = null;
    repeat = null;
  };

  btn.addEventListener('pointerdown', () => {
    nudge(input, direction);
    // Hold to repeat, the way the native spinner does — without it, setting a bed from
    // 0 to 60 in steps of 5 is twelve separate clicks.
    timer = setTimeout(() => {
      repeat = setInterval(() => nudge(input, direction), REPEAT_EVERY_MS);
    }, REPEAT_DELAY_MS);
  });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel'] as const) {
    btn.addEventListener(ev, stop);
  }
  return btn;
}

/** A name for the button's accessible label, from whatever the field already carries. */
function label(input: HTMLInputElement): string {
  return (
    input.getAttribute('aria-label') ??
    input.placeholder ??
    input.id.replace(/[-_]/g, ' ') ??
    'value'
  );
}

function enhance(input: HTMLInputElement): void {
  if (input.closest('.stepper')) return;

  const group = document.createElement('div');
  group.className = GROUP;
  // The frame belongs to the group now; leaving it on the input draws two boxes.
  for (const util of FRAME) input.classList.remove(util);
  input.classList.add(...FIELD_INSIDE.split(' '));

  input.replaceWith(group);
  group.append(makeButton(input, -1), input, makeButton(input, 1));
  input.addEventListener('input', () => syncDisabled(input));
  input.addEventListener('blur', () => clampTyped(input));
  // A finer keypad than "numeric" wherever the step allows a fraction, so the decimal
  // point is on the keyboard instead of missing on the phones that offer both.
  if (!input.inputMode || input.inputMode === 'text') {
    input.inputMode = decimalsOf(Number(input.step) || 1) > 0 ? 'decimal' : 'numeric';
  }
  syncDisabled(input);
}

/** Enhance what is on the page now, and anything rendered later. */
export function initSteppers(root: ParentNode = document): void {
  for (const input of root.querySelectorAll<HTMLInputElement>('input[type="number"]')) {
    enhance(input);
  }

  // Cards re-render by assigning innerHTML, which throws away the group and puts a bare
  // input back. Observing is the only thing that keeps up without every render site
  // remembering to call this.
  new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node.matches('input[type="number"]')) enhance(node as HTMLInputElement);
        for (const input of node.querySelectorAll<HTMLInputElement>('input[type="number"]')) {
          enhance(input);
        }
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
}
