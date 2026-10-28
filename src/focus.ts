import type { Finding, Rgba } from './types.ts';

type Draft = Omit<Finding, 'fingerprint' | 'screen' | 'viewport'>;

interface FocusStyle {
  outline: string;
  outlineOn: boolean;
  outlineColor: string;
  shadow: string;
  border: string;
  background: string;
  color: string;
}

export interface FocusVisit {
  mark: string;
  name: string;
  hint: string;
  changed: boolean;
  outlineOn: boolean;
  shadowOn: boolean;
  outlineRgba: Rgba | null;
  backRgba: Rgba;
  inView: boolean;
}

// page.evaluate 로 직렬화되므로 바깥 이름을 참조하지 않는다.
export function markFocusables() {
  const sel =
    'a[href], button, input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';
  const store: Record<string, unknown> = {};
  document.querySelectorAll(sel).forEach((el, i) => {
    el.setAttribute('data-uiqa-f', String(i));
    const cs = getComputedStyle(el);
    store[String(i)] = {
      outline: `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor}`,
      shadow: cs.boxShadow,
      border: cs.borderTopColor,
      background: cs.backgroundColor,
      color: cs.color,
    };
  });
  (window as unknown as { __uiqaFocus0: unknown }).__uiqaFocus0 = store;
}

export function unmarkFocusables() {
  document.querySelectorAll('[data-uiqa-f]').forEach((el) => el.removeAttribute('data-uiqa-f'));
  delete (window as unknown as { __uiqaFocus0?: unknown }).__uiqaFocus0;
}

export function focusInPage(): FocusVisit | null {
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return null;
  const mark = el.getAttribute('data-uiqa-f');
  if (mark === null) return null;
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const rgba = (v: string): [number, number, number, number] | null => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000';
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return d[3] === 0 ? null : [d[0], d[1], d[2], Math.round((d[3] / 255) * 100) / 100];
  };
  const cs = getComputedStyle(el);
  const now: FocusStyle = {
    outline: `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor}`,
    outlineOn: cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0,
    outlineColor: cs.outlineColor,
    shadow: cs.boxShadow,
    border: cs.borderTopColor,
    background: cs.backgroundColor,
    color: cs.color,
  };
  const before = (window as unknown as { __uiqaFocus0: Record<string, Omit<FocusStyle, 'outlineOn' | 'outlineColor'>> })
    .__uiqaFocus0[mark];
  const changed =
    !before ||
    before.outline !== now.outline ||
    before.shadow !== now.shadow ||
    before.border !== now.border ||
    before.background !== now.background ||
    before.color !== now.color;
  let back: [number, number, number, number] = [255, 255, 255, 1];
  for (let p = el.parentElement; p; p = p.parentElement) {
    const c = rgba(getComputedStyle(p).backgroundColor);
    if (c && c[3] >= 0.99) {
      back = c;
      break;
    }
  }
  const r = el.getBoundingClientRect();
  const raw = el.getAttribute('aria-label') ?? (el as HTMLElement).innerText ?? el.getAttribute('title') ?? '';
  const text = raw.replace(/\s+/g, ' ').trim().slice(0, 40);
  const role = el.getAttribute('role') ?? el.tagName.toLowerCase();
  return {
    mark,
    name: text ? `${role} 「${text}」` : role,
    hint: `${el.tagName.toLowerCase()}${Array.from(el.classList)
      .slice(0, 4)
      .map((c) => `.${c}`)
      .join('')}`,
    changed,
    outlineOn: now.outlineOn,
    shadowOn: now.shadow !== 'none',
    outlineRgba: now.outlineOn ? rgba(now.outlineColor) : null,
    backRgba: back,
    inView: r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth,
  };
}

function luminance(c: Rgba): number {
  const [r, g, b] = c.slice(0, 3).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function focusDrafts(visits: FocusVisit[]): Draft[] {
  const out: Draft[] = [];
  for (const v of visits) {
    if (!v.inView) {
      out.push({
        rule: 'focus-visible',
        verdict: 'confirmed',
        target: v.name,
        hint: v.hint,
        property: '포커스 위치',
        actual: '화면 밖이나 크기 0 인 요소에 포커스',
        expected: '보이는 요소',
      });
      continue;
    }
    if (!v.changed) {
      out.push({
        rule: 'focus-visible',
        verdict: 'confirmed',
        target: v.name,
        hint: v.hint,
        property: '포커스 표시',
        actual: '포커스 전후 모양이 같다',
        expected: '테두리·그림자·색 중 하나가 바뀜',
        note: 'Tab 으로 옮겨 쟀다',
      });
      continue;
    }
    if (v.outlineOn && v.outlineRgba && !v.shadowOn) {
      const [hi, lo] = [luminance(v.outlineRgba), luminance(v.backRgba)].sort((a, b) => b - a);
      const ratio = (hi + 0.05) / (lo + 0.05);
      if (ratio < 3)
        out.push({
          rule: 'focus-visible',
          verdict: 'needs_review',
          target: v.name,
          hint: v.hint,
          property: '포커스 테두리 대비',
          actual: `${ratio.toFixed(2)}:1`,
          expected: '3:1 이상',
        });
    }
  }
  return out;
}
