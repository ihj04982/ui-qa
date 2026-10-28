import type { PageSnapshot } from './types.ts';

export interface CollectArgs {
  touchExempt: string[];
  tokenExclude: string[];
}

// page.evaluate 로 직렬화되므로 바깥 이름을 참조하지 않는다.
export function collectInPage(args: CollectArgs): PageSnapshot {
  type Rgba = [number, number, number, number];

  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const colorCache = new Map<string, Rgba | null>();

  function toRgba(value: string): Rgba | null {
    if (!value || value === 'none') return null;
    const hit = colorCache.get(value);
    if (hit !== undefined) return hit;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000';
    ctx.fillStyle = value;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    const out: Rgba | null = d[3] === 0 ? null : [d[0], d[1], d[2], Math.round((d[3] / 255) * 100) / 100];
    colorCache.set(value, out);
    return out;
  }

  const INTERACTIVE_ROLES = new Set([
    'button',
    'link',
    'tab',
    'checkbox',
    'radio',
    'switch',
    'menuitem',
    'option',
    'slider',
    'combobox',
    'textbox',
    'spinbutton',
  ]);

  function roleOf(el: Element): string | null {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.split(' ')[0];
    const tag = el.tagName.toLowerCase();
    if (tag === 'button') return 'button';
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const type = (el as HTMLInputElement).type;
      if (type === 'hidden') return null;
      if (type === 'checkbox' || type === 'radio' || type === 'range') return type === 'range' ? 'slider' : type;
      if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
      return 'textbox';
    }
    if (/^h[1-6]$/.test(tag)) return 'heading';
    return null;
  }

  function squash(text: string, max = 40): string {
    const t = text.replace(/\s+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
  }

  function ownTextOf(el: Element): string {
    let t = '';
    for (const node of el.childNodes) if (node.nodeType === Node.TEXT_NODE) t += node.textContent ?? '';
    return squash(t, 80);
  }

  function labelOf(el: Element): string {
    const aria = el.getAttribute('aria-label');
    if (aria) return squash(aria);
    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) {
      const text = labelledby
        .split(' ')
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' ');
      if (text.trim()) return squash(text);
    }
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      const byFor = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent : null;
      if (byFor) return squash(byFor);
      if (el.placeholder) return squash(el.placeholder);
    }
    const inner = (el as HTMLElement).innerText ?? el.textContent ?? '';
    if (inner.trim()) return squash(inner);
    const title = el.getAttribute('title') ?? el.getAttribute('alt');
    return title ? squash(title) : '';
  }

  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const all = Array.from(document.body.querySelectorAll('*'));
  const index = new Map<Element, number>();
  const records: PageSnapshot['elements'] = [];

  for (const el of all) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'template' || tag === 'noscript') continue;
    if (el.closest('svg') && tag !== 'svg') continue;
    if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) continue;
    const cs = getComputedStyle(el);
    if (cs.clip !== 'auto' && cs.position === 'absolute') continue;

    const role = roleOf(el);
    const disabled = el.closest(':disabled, [aria-disabled="true"], [data-disabled]') !== null;
    const interactive = role !== null && INTERACTIVE_ROLES.has(role);
    const borderWidth = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth) + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);
    const ownText = ownTextOf(el);

    let parent: number | null = null;
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const pi = index.get(p);
      if (pi !== undefined) {
        parent = pi;
        break;
      }
    }

    const i = records.length;
    index.set(el, i);
    records.push({
      i,
      parent,
      tag,
      role,
      label: labelOf(el),
      hint: `${tag}${Array.from(el.classList).slice(0, 4).map((c) => `.${c}`).join('')}`,
      ownText,
      interactive,
      disabled,
      touchExempt: args.touchExempt.some((sel) => el.closest(sel) !== null),
      fixed: cs.position === 'fixed',
      rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      color: ownText ? toRgba(cs.color) : null,
      background: toRgba(cs.backgroundColor),
      border: borderWidth > 0 && cs.borderTopStyle !== 'none' ? toRgba(cs.borderTopColor) : null,
      fontFamily: cs.fontFamily,
      fontWeight: Number(cs.fontWeight),
      fontStyle: cs.fontStyle,
      fontSize: parseFloat(cs.fontSize),
      overflowX: cs.overflowX,
      ellipsis: cs.textOverflow === 'ellipsis' || (cs.webkitLineClamp !== 'none' && cs.webkitLineClamp !== ''),
      scroll: { sw: (el as HTMLElement).scrollWidth, cw: (el as HTMLElement).clientWidth },
      clip: null,
      offscreen: null,
    });
  }

  const CLIPPING = new Set(['hidden', 'clip']);
  const SCROLLING = new Set(['auto', 'scroll']);

  for (const el of all) {
    const i = index.get(el);
    if (i === undefined) continue;
    const rec = records[i];
    const r = el.getBoundingClientRect();
    let scrollX = false;
    let scrollY = false;
    if (!rec.fixed) {
      for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
        const pcs = getComputedStyle(p);
        if (pcs.position === 'fixed') break;
        const pr = p.getBoundingClientRect();
        if (!scrollX) {
          if (SCROLLING.has(pcs.overflowX)) scrollX = true;
          else if (CLIPPING.has(pcs.overflowX)) {
            const over = Math.max(pr.left - r.left, r.right - pr.right);
            if (over > 1 && !rec.clip) {
              const by = index.get(p) ?? -1;
              rec.clip = { by, axis: 'x', over: Math.round(over) };
            }
          }
        }
        if (!scrollY) {
          if (SCROLLING.has(pcs.overflowY)) scrollY = true;
          else if (CLIPPING.has(pcs.overflowY)) {
            const over = Math.max(pr.top - r.top, r.bottom - pr.bottom);
            if (over > 1 && !rec.clip) {
              const by = index.get(p) ?? -1;
              rec.clip = { by, axis: 'y', over: Math.round(over) };
            }
          }
        }
      }
    }
    if (!scrollX) {
      const over = Math.max(-r.left, r.right - vw);
      if (over > 1) rec.offscreen = { axis: 'x', over: Math.round(over) };
    }
    if (!scrollY && !rec.offscreen) {
      const over = Math.max(-r.top, r.bottom - vh);
      if (over > 1) rec.offscreen = { axis: 'y', over: Math.round(over) };
    }
  }

  const fonts: PageSnapshot['fonts'] = [];
  document.fonts.forEach((f) =>
    fonts.push({ family: f.family.replace(/^["']|["']$/g, ''), weight: f.weight, style: f.style, status: f.status }),
  );

  const exclude = args.tokenExclude.map((s) => new RegExp(s));
  const names = new Set<string>();
  let unreadable = 0;
  function walk(rules: CSSRuleList) {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSStyleRule) {
        for (const prop of Array.from(rule.style)) if (prop.startsWith('--')) names.add(prop);
      }
      if ('cssRules' in rule && (rule as CSSGroupingRule).cssRules) walk((rule as CSSGroupingRule).cssRules);
    }
  }
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      walk(sheet.cssRules);
    } catch {
      unreadable += 1;
    }
  }
  const probe = document.createElement('div');
  probe.style.display = 'none';
  document.body.appendChild(probe);
  const tokens: PageSnapshot['tokens'] = [];
  for (const name of names) {
    if (exclude.some((re) => re.test(name))) continue;
    probe.style.color = '';
    probe.style.color = `var(${name})`;
    const resolved = getComputedStyle(probe).color;
    const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    if (!raw || !CSS.supports('color', raw)) continue;
    const rgba = toRgba(resolved);
    if (rgba) tokens.push({ name, rgba });
  }
  probe.remove();

  const root = document.documentElement;
  let pageBackground: Rgba = [255, 255, 255, 1];
  for (const el of [root, document.body]) {
    const c = toRgba(getComputedStyle(el).backgroundColor);
    if (!c) continue;
    const a = c[3];
    pageBackground = [
      Math.round(c[0] * a + pageBackground[0] * (1 - a)),
      Math.round(c[1] * a + pageBackground[1] * (1 - a)),
      Math.round(c[2] * a + pageBackground[2] * (1 - a)),
      1,
    ];
  }
  return {
    pageBackground,
    url: location.href,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    documentOverflow: { x: root.scrollWidth - root.clientWidth, y: root.scrollHeight - root.clientHeight },
    elements: records,
    fonts,
    tokens,
    tokenSheetsUnreadable: unreadable,
  };
}
