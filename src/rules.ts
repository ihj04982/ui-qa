import { createHash } from 'node:crypto';

import type { ElementRecord, Finding, PageSnapshot, QaConfig, Rgba, Verdict } from './types.ts';

interface Context {
  snap: PageSnapshot;
  config: QaConfig;
  screen: string;
  viewport: string;
  names: string[];
  children: number[][];
}

type Draft = Omit<Finding, 'fingerprint' | 'screen' | 'viewport'>;

export function stableText(text: string): string {
  return text.replace(/\d+(?:[.:,]\d+)*/g, 'N');
}

export function fingerprint(f: Pick<Finding, 'rule' | 'screen' | 'viewport' | 'target' | 'property'>): string {
  return createHash('sha1')
    .update([f.rule, f.screen, f.viewport, stableText(f.target), f.property].join('\u0000'))
    .digest('hex')
    .slice(0, 12);
}

function targetNames(elements: ElementRecord[]): { names: string[]; keys: string[] } {
  const base = elements.map((e) => {
    const kind = e.role ?? e.tag;
    if (e.label) return `${kind} 「${e.label}」`;
    const owner = nearestLabelled(elements, e);
    return owner ? `${kind} (「${owner.label}」 안)` : kind;
  });
  const seen = new Map<string, number>();
  const seenKey = new Map<string, number>();
  const names: string[] = [];
  const keys: string[] = [];
  for (const name of base) {
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    names.push(n === 1 ? name : `${name} #${n}`);
    const key = stableText(name);
    const k = (seenKey.get(key) ?? 0) + 1;
    seenKey.set(key, k);
    keys.push(k === 1 ? key : `${key} #${k}`);
  }
  return { names, keys };
}

function nearestLabelled(elements: ElementRecord[], e: ElementRecord): ElementRecord | null {
  for (let p = e.parent; p !== null; p = elements[p].parent) if (elements[p].label) return elements[p];
  return null;
}

function hasContent(ctx: Context, i: number, within: (j: number) => boolean): boolean {
  const e = ctx.snap.elements[i];
  if (e.ownText || e.interactive) return true;
  return ctx.children[i].some((c) => within(c) && hasContent(ctx, c, within));
}

function documentOverflow(ctx: Context): Draft[] {
  const { x, y } = ctx.snap.documentOverflow;
  const { width, height } = ctx.snap.viewport;
  const out: Draft[] = [];
  if (x > 0)
    out.push({
      rule: 'document-overflow',
      verdict: 'confirmed',
      target: '화면 전체',
      property: '가로 폭',
      actual: `${width + x}px`,
      expected: `${width}px 이하`,
      note: '가로 스크롤이 생긴다',
    });
  if (y > 0)
    out.push({
      rule: 'document-overflow',
      verdict: 'confirmed',
      target: '화면 전체',
      property: '세로 높이',
      actual: `${height + y}px`,
      expected: `${height}px 이하`,
      note: '스크롤 없는 한 판에 담기지 않는다',
    });
  return out;
}

function offscreen(ctx: Context): Draft[] {
  const els = ctx.snap.elements;
  const off = (j: number) => els[j].offscreen !== null;
  return els
    .filter((e) => e.offscreen && !e.clip && !(e.parent !== null && off(e.parent)) && hasContent(ctx, e.i, off))
    .map((e) => ({
      rule: 'offscreen',
      verdict: 'confirmed' as Verdict,
      target: ctx.names[e.i],
      property: e.offscreen!.axis === 'x' ? '가로 위치' : '세로 위치',
      actual: `화면 밖으로 ${e.offscreen!.over}px`,
      expected: '화면 안',
    }));
}

function clipped(ctx: Context): Draft[] {
  const els = ctx.snap.elements;
  return els
    .filter((e) => {
      if (!e.clip) return false;
      const by = e.clip.by;
      const sameClip = (j: number) => els[j].clip?.by === by;
      if (e.parent !== null && sameClip(e.parent)) return false;
      if (by >= 0 && els[by].ellipsis) return false;
      return hasContent(ctx, e.i, sameClip);
    })
    .map((e) => {
      const owner = e.clip!.by >= 0 ? `\`${els[e.clip!.by].hint}\`` : '바깥 상자';
      return {
        rule: 'clipped',
        verdict: 'confirmed' as Verdict,
        target: ctx.names[e.i],
        property: e.clip!.axis === 'x' ? '가로 잘림' : '세로 잘림',
        actual: `${e.clip!.over}px 가려짐`,
        expected: '0px',
        note: `${owner} 의 overflow-hidden 에 가려진다 (문서 스크롤이 안 생겨 넘침 검사를 통과한다)`,
      };
    });
}

function truncated(ctx: Context): Draft[] {
  return ctx.snap.elements
    .filter((e) => (e.ownText || (e.ellipsis && e.label)) && (e.overflowX === 'hidden' || e.overflowX === 'clip') && e.scroll.sw > e.scroll.cw + 1)
    .map((e) => ({
      rule: 'text-truncated',
      verdict: 'needs_review' as Verdict,
      target: ctx.names[e.i],
      property: '글자 잘림',
      actual: `${e.scroll.sw - e.scroll.cw}px 넘침`,
      expected: '0px',
      note: '말줄임을 의도했는지 확인',
    }));
}

function touchTarget(ctx: Context): Draft[] {
  const min = ctx.config.minTarget;
  const els = ctx.snap.elements;
  const targets = els.filter((e) => e.interactive && !e.touchExempt);
  const small = targets.filter((e) => e.rect.w < min || e.rect.h < min);
  const smallSet = new Set(small);
  const center = (e: ElementRecord) => [e.rect.x + e.rect.w / 2, e.rect.y + e.rect.h / 2];
  const related = (a: ElementRecord, b: ElementRecord) => {
    for (let p = a.parent; p !== null; p = els[p].parent) if (p === b.i) return true;
    for (let p = b.parent; p !== null; p = els[p].parent) if (p === a.i) return true;
    return false;
  };
  const crowded = (e: ElementRecord) => {
    const [cx, cy] = center(e);
    return targets.some((o) => {
      if (o === e || related(o, e)) return false;
      if (smallSet.has(o)) {
        const [ox, oy] = center(o);
        return Math.hypot(ox - cx, oy - cy) < min;
      }
      const dx = Math.max(o.rect.x - cx, 0, cx - (o.rect.x + o.rect.w));
      const dy = Math.max(o.rect.y - cy, 0, cy - (o.rect.y + o.rect.h));
      return Math.hypot(dx, dy) < min / 2;
    });
  };
  return small
    .filter((e) => !ctx.config.targetSpacing || crowded(e))
    .map((e) => ({
      rule: 'touch-target',
      verdict: 'confirmed' as Verdict,
      target: ctx.names[e.i],
      property: '누르는 크기',
      actual: `${e.rect.w}×${e.rect.h}`,
      expected: `${min}×${min} 이상`,
      note: ctx.config.targetSpacing ? `작은데 ${min}px 안에 다른 누르는 요소가 있다` : undefined,
    }));
}

function weightCovered(descriptor: string, weight: number): boolean {
  const parts = descriptor.split(/\s+/).map((p) => (p === 'normal' ? 400 : p === 'bold' ? 700 : Number(p)));
  if (parts.length === 1) return parts[0] === weight;
  return weight >= parts[0] && weight <= parts[1];
}

function fontFace(ctx: Context): Draft[] {
  const system = new Set(ctx.config.systemFonts.map((f) => f.toLowerCase()));
  const groups = new Map<string, ElementRecord[]>();
  for (const e of ctx.snap.elements) {
    if (!e.ownText) continue;
    const family = e.fontFamily.split(',')[0].trim().replace(/^["']|["']$/g, '');
    if (system.has(family.toLowerCase())) continue;
    const key = `${family}\u0000${e.fontWeight}\u0000${e.fontStyle}`;
    const list = groups.get(key) ?? [];
    list.push(e);
    groups.set(key, list);
  }
  const out: Draft[] = [];
  for (const [key, list] of groups) {
    const [family, w, style] = key.split('\u0000');
    const weight = Number(w);
    const faces = ctx.snap.fonts.filter((f) => f.family.toLowerCase() === family.toLowerCase());
    const sample = ctx.names[list[0].i];
    if (faces.length === 0) {
      out.push({
        rule: 'font-face',
        verdict: 'confirmed',
        target: `글꼴 「${family}」`,
        property: '글꼴 파일',
        actual: '불러온 파일 없음',
        expected: '@font-face 로 불러옴',
        note: `대체 글꼴로 그려진다. 예: ${sample}`,
        count: list.length,
      });
      continue;
    }
    const styled = faces.filter((f) => f.style === style || (style === 'normal' && f.style === 'normal'));
    const covering = styled.filter((f) => weightCovered(f.weight, weight));
    const failed = covering.filter((f) => f.status === 'error');
    if (covering.length === 0) {
      const have = [...new Set(styled.map((f) => f.weight))].join(', ') || '없음';
      out.push({
        rule: 'font-face',
        verdict: 'confirmed',
        target: `글꼴 「${family}」 굵기 ${weight}`,
        property: '굵기',
        actual: `굵기 ${weight} 파일 없음 (있는 굵기: ${have})`,
        expected: `굵기 ${weight} 파일`,
        note: `브라우저가 가까운 굵기로 바꿔 그려 위계가 흐려진다. 예: ${sample}`,
        count: list.length,
      });
    } else if (failed.length === covering.length) {
      out.push({
        rule: 'font-face',
        verdict: 'confirmed',
        target: `글꼴 「${family}」 굵기 ${weight}`,
        property: '글꼴 파일',
        actual: '불러오기 실패',
        expected: '불러옴',
        note: `예: ${sample}`,
        count: list.length,
      });
    }
  }
  return out;
}

function hex(c: Rgba): string {
  const h = c
    .slice(0, 3)
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');
  return c[3] < 1 ? `#${h} (불투명도 ${c[3]})` : `#${h}`;
}

function matchesToken(c: Rgba, tokens: PageSnapshot['tokens']): boolean {
  const tol = c[3] < 0.5 ? 4 : 1;
  return tokens.some((t) => {
    const close = Math.abs(t.rgba[0] - c[0]) <= tol && Math.abs(t.rgba[1] - c[1]) <= tol && Math.abs(t.rgba[2] - c[2]) <= tol;
    return close && (c[3] < 1 || Math.abs(t.rgba[3] - c[3]) <= 0.02);
  });
}

function nearestToken(c: Rgba, tokens: PageSnapshot['tokens']): string {
  let best = '';
  let dist = Infinity;
  for (const t of tokens) {
    const d = (t.rgba[0] - c[0]) ** 2 + (t.rgba[1] - c[1]) ** 2 + (t.rgba[2] - c[2]) ** 2;
    if (d < dist) {
      dist = d;
      best = `${t.name} ${hex(t.rgba)}`;
    }
  }
  return best;
}

function colorToken(ctx: Context): Draft[] {
  const tokens = ctx.snap.tokens;
  if (tokens.length === 0) return [];
  const props = [
    ['color', '글자색'],
    ['background', '배경색'],
    ['border', '테두리색'],
  ] as const;
  const groups = new Map<string, { label: string; color: Rgba; list: ElementRecord[] }>();
  for (const e of ctx.snap.elements) {
    for (const [key, label] of props) {
      const c = e[key];
      if (!c || matchesToken(c, tokens)) continue;
      const g = `${label}\u0000${hex(c)}`;
      const entry = groups.get(g) ?? { label, color: c, list: [] };
      entry.list.push(e);
      groups.set(g, entry);
    }
  }
  return [...groups.values()].map(({ label, color, list }) => ({
    rule: 'color-token',
    verdict: 'needs_review' as Verdict,
    target: ctx.names[list[0].i],
    property: label,
    actual: hex(color),
    expected: `토큰 색 (가까운 것: ${nearestToken(color, tokens)})`,
    note: list.length > 1 ? `같은 색 ${list.length}곳` : undefined,
    count: list.length,
  }));
}

function effectiveBackground(ctx: Context, e: ElementRecord): Rgba {
  const layers: Rgba[] = [];
  for (let cur: ElementRecord | null = e; cur; cur = cur.parent === null ? null : ctx.snap.elements[cur.parent]) {
    if (cur.background) layers.push(cur.background);
    if (cur.background && cur.background[3] >= 0.99) break;
  }
  let out: Rgba = ctx.snap.pageBackground;
  for (const c of layers.reverse()) {
    const a = c[3];
    out = [
      Math.round(c[0] * a + out[0] * (1 - a)),
      Math.round(c[1] * a + out[1] * (1 - a)),
      Math.round(c[2] * a + out[2] * (1 - a)),
      1,
    ];
  }
  return out;
}

function luminance(c: Rgba): number {
  const [r, g, b] = c.slice(0, 3).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(ctx: Context): Draft[] {
  const out: Draft[] = [];
  const seen = new Set<string>();
  for (const e of ctx.snap.elements) {
    if (!e.ownText || !e.color || e.disabled) continue;
    const bg = effectiveBackground(ctx, e);
    const a = e.color[3];
    const fg: Rgba = [
      Math.round(e.color[0] * a + bg[0] * (1 - a)),
      Math.round(e.color[1] * a + bg[1] * (1 - a)),
      Math.round(e.color[2] * a + bg[2] * (1 - a)),
      1,
    ];
    const [hi, lo] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
    const ratio = (hi + 0.05) / (lo + 0.05);
    const large = e.fontSize >= 24 || (e.fontSize >= 18.66 && e.fontWeight >= 700);
    const need = large ? 3 : 4.5;
    if (ratio >= need) continue;
    const key = `${hex(fg)}/${hex(bg)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      rule: 'contrast',
      verdict: 'needs_review',
      target: ctx.names[e.i],
      property: '글자 대비',
      actual: `${ratio.toFixed(2)}:1 (글자 ${hex(fg)} · 배경 ${hex(bg)})`,
      expected: `${need}:1 이상`,
    });
  }
  return out;
}

const RULES = [documentOverflow, offscreen, clipped, truncated, touchTarget, fontFace, colorToken, contrast];

export function runRules(snap: PageSnapshot, config: QaConfig, screen: string, viewport: string): Finding[] {
  const children: number[][] = snap.elements.map(() => []);
  for (const e of snap.elements) if (e.parent !== null) children[e.parent].push(e.i);
  const { names, keys } = targetNames(snap.elements);
  const ctx: Context = { snap, config, screen, viewport, names, children };
  return RULES.flatMap((rule) => rule(ctx)).map((d) => {
    const owner = names.indexOf(d.target);
    if (owner >= 0 && !d.hint) d = { ...d, hint: snap.elements[owner].hint };
    const f = { ...d, screen, viewport };
    const key = owner >= 0 ? keys[owner] : d.target;
    return { ...f, fingerprint: fingerprint({ ...f, target: key }) };
  });
}
