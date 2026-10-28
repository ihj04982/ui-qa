import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { parse } from 'yaml';

import { modeLabel, type Finding, type QaConfig, type ScreenResult } from './types.ts';

export interface Decision {
  fingerprint: string;
  decision: 'keep' | 'false_positive';
  reason: string;
  date?: string;
}

export interface Unseen {
  screen: string;
  viewport: string;
  reason: string;
}

export interface Report {
  open: Finding[];
  baseline: Finding[];
  decided: { finding: Finding; decision: Decision }[];
  unseen: Unseen[];
  screens: ScreenResult[];
  notes: string[];
  pass: boolean;
}

export interface GitContext {
  expectedBase?: string;
  shallow?: boolean;
}

export type FailOn = 'confirmed' | 'all' | 'never';

export async function readScreens(dir: string): Promise<ScreenResult[]> {
  const folder = path.join(dir, 'screens');
  let files: string[];
  try {
    files = await readdir(folder);
  } catch {
    return [];
  }
  const out: ScreenResult[] = [];
  for (const f of files.filter((n) => n.endsWith('.json')).sort())
    out.push(JSON.parse(await readFile(path.join(folder, f), 'utf8')) as ScreenResult);
  return out;
}

export async function readDecisions(file: string | undefined): Promise<Decision[]> {
  if (!file) return [];
  try {
    const parsed = parse(await readFile(file, 'utf8')) as Decision[] | null;
    return parsed ?? [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

export function buildReport(
  screens: ScreenResult[],
  config: QaConfig,
  decisions: Decision[],
  base: ScreenResult[] | null,
  failOn: FailOn,
  git: GitContext = {},
): Report {
  const unseen: Unseen[] = [];
  for (const s of screens)
    if (s.status !== 'inspected') unseen.push({ screen: s.screen, viewport: s.viewport, reason: s.reason ?? s.status });
  const seen = new Set(screens.map((s) => s.screen));
  for (const name of config.screens)
    if (!seen.has(name)) unseen.push({ screen: name, viewport: '-', reason: '설정에 있으나 이번 실행에서 열리지 않았다' });
  const { viewports: modeVps, themes } = config.modes;
  const expectedModes =
    modeVps.length > 0 || themes.length > 0
      ? (modeVps.length > 0 ? modeVps : config.viewports).flatMap((vp) =>
          themes.length > 0 ? themes.map((t) => modeLabel(vp, t)) : [vp],
        )
      : config.viewports;
  if (expectedModes.length > 0) {
    for (const name of config.screens.filter((n) => seen.has(n)))
      for (const vp of expectedModes)
        if (!screens.some((s) => s.screen === name && s.viewport === vp))
          unseen.push({ screen: name, viewport: vp, reason: '이 판 크기로 재지 않았다' });
  }

  const baseKeys = new Set((base ?? []).flatMap((s) => s.findings.map((f) => f.fingerprint)));
  const byFp = new Map(decisions.map((d) => [d.fingerprint, d]));
  const open: Finding[] = [];
  const baseline: Finding[] = [];
  const decided: Report['decided'] = [];
  for (const f of screens.flatMap((s) => s.findings)) {
    const d = byFp.get(f.fingerprint);
    if (d) decided.push({ finding: f, decision: d });
    else if (baseKeys.has(f.fingerprint)) baseline.push(f);
    else open.push(f);
  }

  const blocking =
    failOn === 'never' ? [] : failOn === 'all' ? open : open.filter((f) => f.verdict === 'confirmed');
  const pass = blocking.length === 0 && (failOn === 'never' || unseen.length === 0);

  const notes: string[] = [];
  if (git.shallow) notes.push('얕은 clone 이라 merge-base 를 계산하지 못했다. CI 에서 fetch-depth 를 0 으로 둔다');
  if (!base) notes.push('기준선 결과가 없어 작업 전부터 있던 차이를 빼지 않았다');
  else {
    const baseCommits = [...new Set(base.map((s) => s.commit).filter(Boolean))] as string[];
    if (git.expectedBase && baseCommits.some((c) => !c.startsWith(git.expectedBase!) && !git.expectedBase!.startsWith(c)))
      notes.push(
        `기준선이 merge-base ${git.expectedBase.slice(0, 7)} 가 아니라 ${baseCommits.map((c) => c.slice(0, 7)).join(', ')} 에서 만들어졌다. 제외한 차이를 믿지 않는다`,
      );
    if (base.some((s) => s.dirty)) notes.push('기준선 결과에 커밋 안 된 변경이 섞였다');
  }
  if (screens.some((s) => s.dirty)) notes.push('이번 결과에 커밋 안 된 변경이 섞였다');
  const failed = screens.filter((s) => (s.apiFailures ?? []).length > 0);
  if (failed.length > 0) {
    const calls = [...new Set(failed.flatMap((s) => s.apiFailures ?? []))];
    notes.push(`API 가 5xx 를 돌려준 상태에서 잰 화면 ${failed.length}판 (${calls.join(', ')}). 오류 상태 화면일 수 있다`);
  }
  return { open, baseline, decided, unseen, screens, notes, pass };
}

const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';

function mark(n: number): string {
  return n <= CIRCLED.length ? CIRCLED[n - 1] : `(${n})`;
}

export function renderMarkdown(r: Report): string {
  const confirmed = r.open.filter((f) => f.verdict === 'confirmed').length;
  const review = r.open.length - confirmed;
  const lines: string[] = [];
  lines.push(`## UI QA — 수정 필요 ${r.open.length}곳 (확인됨 ${confirmed} · 확인 필요 ${review}) · 못 본 화면 ${r.unseen.length}`);
  lines.push('');
  const verdict = r.pass ? '**QA 넘김 가능**' : '**QA 넘김 불가**';
  const why = r.unseen.length > 0 && !r.pass ? ' — 못 본 화면이 있으면 통과로 치지 않는다' : '';
  lines.push(`${verdict}${why}`);
  const extra: string[] = [];
  if (r.baseline.length > 0) extra.push(`작업 전부터 있던 차이 ${r.baseline.length}건 제외`);
  if (r.decided.length > 0) extra.push(`decisions.yaml 로 정리한 ${r.decided.length}건 제외`);
  extra.push(`잰 화면 ${r.screens.filter((s) => s.status === 'inspected').length}`);
  lines.push(extra.join(' · '));
  for (const n of r.notes) lines.push(`> ⚠ ${n}`);

  const patterns = new Map<string, Finding[]>();
  for (const f of r.open) {
    const key =
      f.rule === 'text-truncated' ? `${f.rule}\u0000${f.hint ?? ''}` : `${f.rule}\u0000${f.property}\u0000${f.actual}`;
    patterns.set(key, [...(patterns.get(key) ?? []), f]);
  }
  const shared = [...patterns.values()]
    .filter((list) => list.length >= 3 || new Set(list.map((f) => f.screen)).size >= 2)
    .sort((a, b) => (a[0].verdict === b[0].verdict ? b.length - a.length : a[0].verdict === 'confirmed' ? -1 : 1));
  const sharedSet = new Set(shared.flat());
  if (shared.length > 0) {
    lines.push('', '### 같은 차이 묶음');
    shared.forEach((list, idx) => {
      const f = list[0];
      const tag = f.verdict === 'confirmed' ? '확인됨' : '확인 필요';
      const where = new Set(list.map((x) => x.screen)).size;
      const head =
        f.rule === 'text-truncated'
          ? `${f.property}: \`${f.hint}\` 칸에서 (최대 ${Math.max(...list.map((x) => parseInt(x.actual, 10)))}px 넘침)`
          : `${f.property}: 앱 ${f.actual} → ${f.expected} —`;
      lines.push(`${mark(idx + 1)} [${tag}] ${head} ${list.length}곳 · 화면 ${where}개`);
      const shown = list.slice(0, 6).map((x) => `「${x.screen}」 ${x.target}`);
      if (list.length > 6) shown.push(`외 ${list.length - 6}곳`);
      lines.push(`   ${shown.join(' · ')} · \`${f.rule}\``);
    });
  }

  const groups = new Map<string, Finding[]>();
  for (const f of r.open.filter((x) => !sharedSet.has(x))) {
    const key = `${f.screen}\u0000${f.viewport}`;
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  for (const [key, list] of groups) {
    const [screen, vp] = key.split('\u0000');
    lines.push('', `### 「${screen}」 ${vp}`);
    list
      .sort((a, b) => (a.verdict === b.verdict ? 0 : a.verdict === 'confirmed' ? -1 : 1))
      .forEach((f, idx) => {
        const tag = f.verdict === 'confirmed' ? '확인됨' : '확인 필요';
        lines.push(`${mark(idx + 1)} [${tag}] ${f.target} — ${f.property}: 앱 ${f.actual} → ${f.expected}`);
        const tail = [f.hint ? `\`${f.hint}\`` : '', f.note, `\`${f.rule}\` \`${f.fingerprint}\``].filter(Boolean).join(' · ');
        lines.push(`   ${tail}`);
      });
  }

  const clean = r.screens.filter((s) => s.status === 'inspected' && !r.open.some((f) => f.screen === s.screen && f.viewport === s.viewport));
  if (clean.length > 0) {
    lines.push('', '### 고칠 곳 없음');
    for (const s of clean) lines.push(`- 「${s.screen}」 ${s.viewport} (요소 ${s.elements}, 토큰 ${s.tokens})`);
  }
  if (r.unseen.length > 0) {
    lines.push('', '### 못 본 화면');
    for (const u of r.unseen) lines.push(`- 「${u.screen}」 ${u.viewport} — ${u.reason}`);
  }
  if (r.screens.some((s) => s.status === 'inspected' && s.tokens === 0))
    lines.push('', '> 토큰을 하나도 읽지 못한 화면이 있다. 그 화면은 색 검사를 하지 않았다.');
  return `${lines.join('\n')}\n`;
}

export async function writeReport(dir: string, r: Report): Promise<string> {
  const md = renderMarkdown(r);
  await writeFile(path.join(dir, 'report.md'), md);
  await writeFile(path.join(dir, 'findings.json'), JSON.stringify(r, null, 2));
  return md;
}
