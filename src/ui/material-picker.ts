/**
 * A searchable dropdown for filament material, enhancing any
 * `input[data-material-picker]` with a filtered list — so entering "PLA" or something
 * far less common, like a carbon-fibre or wood-fill blend, is a few keystrokes and a
 * pick rather than typing the exact spelling from memory.
 *
 * ## Free text always wins
 *
 * The list is a shortcut, not a closed set. This app's own `materialKey()`
 * (`workshop/cost-core.ts`) just trims and upper-cases whatever is typed, and a spool
 * holding a material this list has never heard of — a store's own blend, a filament
 * from a brand with its own name for it — is still a material. Picking an option fills
 * the field; it does not restrict what can stay in it.
 *
 * ## Enhancement, not markup
 *
 * Same reasoning as `stepper.ts`: applied at runtime to `input[data-material-picker]`
 * wherever one exists now or is rendered later, because the Cost and Inventory panels
 * both rebuild their forms wholesale on a refetch, and markup duplicated in two files
 * would drift. The input is MOVED into a wrapper, never recreated, so listeners already
 * bound to it (the Cost panel's material-price row, Inventory's colour sync) survive.
 */

/** Roughly what a slicer's own material dropdown offers. */
const BASIC = ['PLA', 'PLA+', 'PETG', 'ABS', 'ASA', 'TPU', 'Nylon (PA)', 'PC', 'PVA', 'HIPS', 'PP'];

/** Reinforced, engineering and novelty filaments — the ones worth a shortcut most. */
const WILD = [
  'PLA-CF',
  'PETG-CF',
  'PA-CF',
  'PAHT-CF',
  'ABS-GF',
  'PC-ABS',
  'PC-FR',
  'PEEK',
  'PEI (ULTEM)',
  'PPS',
  'PPA',
  'POM',
  'PCTG',
  'PETG-GF',
  'TPE',
  'PVB',
  'BVOH',
  'Silk PLA',
  'Matte PLA',
  'Marble PLA',
  'Wood-fill PLA',
  'Metal-fill PLA',
  'Magnetic PLA',
  'Conductive PLA',
  'Glow-in-the-dark PLA',
];

const WRAP = 'relative';

// `min-w-56` rather than `right-0`: several of these fields (the spool material field,
// the Cost panel's per-material row) are a narrow few characters wide, and a menu tied
// to that width would wrap every option onto two or three lines.
const MENU = [
  'material-picker-menu absolute left-0 top-full mt-1 z-20 min-w-56 w-max max-w-72',
  'max-h-64 overflow-y-auto rounded-lg border border-line bg-raised p-1',
  '[box-shadow:0_4px_16px_rgba(0,_0,_0,_0.35)]',
].join(' ');

const GROUP_LABEL = 'px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-fg-muted';

const OPTION = [
  'material-picker-option flex items-center px-2 py-1.5 rounded-md text-[13px] text-fg',
  'cursor-pointer select-none',
].join(' ');

const OPTION_ACTIVE = 'bg-accent text-white';

interface Group {
  label: string;
  items: string[];
}

function matches(list: readonly string[], query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...list];
  return list.filter((m) => m.toLowerCase().includes(q));
}

function groupsFor(query: string): Group[] {
  return [
    { label: 'Basic', items: matches(BASIC, query) },
    { label: 'Wild', items: matches(WILD, query) },
  ].filter((g) => g.items.length > 0);
}

function flatOptions(groups: readonly Group[]): string[] {
  return groups.flatMap((g) => g.items);
}

class MaterialPicker {
  private input: HTMLInputElement;
  private menu: HTMLElement;
  private activeIndex = -1;

  constructor(input: HTMLInputElement, menu: HTMLElement) {
    this.input = input;
    this.menu = menu;
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'false');
    input.autocomplete = 'off';

    input.addEventListener('input', () => this.open());
    input.addEventListener('focus', () => this.open());
    input.addEventListener('keydown', (e) => this.onKeydown(e));
    // Closing on blur, rather than a document-level "click outside" listener, is what
    // keeps this instance-free of the app: a listener on `document` would outlive every
    // field this enhances, since a form that rebuilds its markup (Cost, Inventory) never
    // removes it. Any click elsewhere moves focus off the input — onto whatever was
    // clicked, or nowhere — so blur already fires for exactly the cases a click-outside
    // listener exists to catch.
    input.addEventListener('blur', () => this.close());
  }

  private render(): void {
    const groups = groupsFor(this.input.value);
    const options = flatOptions(groups);
    if (!options.length) {
      this.menu.innerHTML = '';
      this.menu.classList.add('hidden');
      this.input.setAttribute('aria-expanded', 'false');
      return;
    }
    this.activeIndex = Math.min(this.activeIndex, options.length - 1);
    let i = -1;
    this.menu.innerHTML = groups
      .map(
        (g) => `
          <div class="${GROUP_LABEL}">${g.label}</div>
          ${g.items
            .map((m) => {
              i++;
              const active = i === this.activeIndex;
              return `<div class="${OPTION} ${active ? OPTION_ACTIVE : ''}" role="option"
                data-index="${i}" data-value="${m.replace(/"/g, '&quot;')}"
                aria-selected="${active}">${m}</div>`;
            })
            .join('')}`,
      )
      .join('');
    this.menu.classList.remove('hidden');
    this.input.setAttribute('aria-expanded', 'true');

    // Keep the buttons from stealing focus mid-click — same trick the stepper uses, or
    // the field blurs, closes the menu, and the click lands on nothing.
    for (const opt of this.menu.querySelectorAll<HTMLElement>('[data-index]')) {
      opt.addEventListener('mousedown', (e) => e.preventDefault());
      opt.addEventListener('click', () => this.pick(opt.dataset.value ?? ''));
    }
  }

  private open(): void {
    this.render();
  }

  private close(): void {
    // A timeout, not immediate: a click on an option fires blur first, and closing
    // synchronously would remove the option out from under that same click.
    setTimeout(() => {
      this.menu.classList.add('hidden');
      this.input.setAttribute('aria-expanded', 'false');
    }, 120);
  }

  private pick(value: string): void {
    this.input.value = value;
    this.menu.classList.add('hidden');
    this.input.setAttribute('aria-expanded', 'false');
    this.input.dispatchEvent(new Event('input', { bubbles: true }));
    this.input.dispatchEvent(new Event('change', { bubbles: true }));
    this.input.focus();
  }

  private onKeydown(e: KeyboardEvent): void {
    const options = flatOptions(groupsFor(this.input.value));
    if (e.key === 'Escape') {
      this.menu.classList.add('hidden');
      this.input.setAttribute('aria-expanded', 'false');
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (this.menu.classList.contains('hidden')) {
        this.open();
        return;
      }
      this.activeIndex = Math.min(options.length - 1, this.activeIndex + 1);
      this.render();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.activeIndex = Math.max(0, this.activeIndex - 1);
      this.render();
      return;
    }
    if (e.key === 'Enter' && !this.menu.classList.contains('hidden') && this.activeIndex >= 0) {
      e.preventDefault();
      const value = options[this.activeIndex];
      if (value) this.pick(value);
    }
  }
}

/**
 * Utilities that decide how much of the row the field claims — `flex-1`, `min-w-0`,
 * a fixed `w-24` — as opposed to how it looks. These have to move to the wrapper:
 * the input is no longer the flex item once it is wrapped, so left on the input they
 * go inert and every call site that sizes this field (the Cost panel's `flex-1`
 * material row, Inventory's fixed-width one) silently collapses to the browser's
 * default input width.
 */
const LAYOUT_UTILITY = /^(flex-1|flex-auto|flex-none|grow|shrink|min-w-|max-w-|w-)/;

function enhance(input: HTMLInputElement): void {
  if (input.closest(`.${WRAP}[data-material-wrap]`)) return;

  const wrap = document.createElement('div');
  wrap.className = WRAP;
  wrap.dataset.materialWrap = '';
  for (const cls of [...input.classList]) {
    if (!LAYOUT_UTILITY.test(cls)) continue;
    input.classList.remove(cls);
    wrap.classList.add(cls);
  }
  input.classList.add('w-full');
  input.replaceWith(wrap);
  wrap.append(input);

  const menu = document.createElement('div');
  menu.className = `${MENU} hidden`;
  menu.setAttribute('role', 'listbox');
  wrap.append(menu);

  new MaterialPicker(input, menu);
}

/** Enhance what is on the page now, and anything rendered later. */
export function initMaterialPickers(root: ParentNode = document): void {
  for (const input of root.querySelectorAll<HTMLInputElement>('input[data-material-picker]')) {
    enhance(input);
  }

  new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node.matches('input[data-material-picker]')) enhance(node as HTMLInputElement);
        for (const input of node.querySelectorAll<HTMLInputElement>(
          'input[data-material-picker]',
        )) {
          enhance(input);
        }
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
}
