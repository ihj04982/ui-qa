import { createReadStream, existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

import { useApiArchive } from '../src/har.ts';
import { inspect } from '../src/inspect.ts';
import { buildReport } from '../src/report.ts';
import { defaultConfig, type QaConfig, type ScreenResult } from '../src/types.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, 'fixtures');
const fonts = path.join(here, '..', 'node_modules', '@fontsource', 'inter', 'files');
const TYPES: Record<string, string> = { '.html': 'text/html', '.css': 'text/css', '.woff2': 'font/woff2' };
const NO_CONFIG = path.join(here, 'none.json');

let server: Server;
let origin: string;
let outDir: string;
let apiLabel = 'recorded';

test.beforeAll(async () => {
  outDir = await mkdtemp(path.join(tmpdir(), 'ui-qa-selftest-'));
  server = createServer((req, res) => {
    const url = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    if (url === '/api/data') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ label: apiLabel }));
      return;
    }
    const file = url.startsWith('/fonts/') ? path.join(fonts, url.slice(7)) : path.join(fixtures, url);
    if (!existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  origin = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

test.afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const rulesOf = (r: ScreenResult) => [...new Set(r.findings.map((f) => f.rule))].sort();

const cases: { page: string; rules: string[]; target?: RegExp; config?: Partial<QaConfig> }[] = [
  { page: 'clean', rules: [] },
  { page: 'guard', rules: [] },
  { page: 'document-overflow', rules: ['document-overflow', 'offscreen'] },
  { page: 'clipped', rules: ['clipped'], target: /Finish/ },
  { page: 'touch', rules: ['touch-target'], target: /Jog/ },
  { page: 'font-weight', rules: ['font-face'], target: /굵기 600/ },
  { page: 'color-token', rules: ['color-token'], target: /Almost primary/ },
  { page: 'contrast', rules: ['contrast'] },
  { page: 'truncate', rules: ['text-truncated'] },
  { page: 'ellipsis-nested', rules: ['text-truncated'] },
  { page: 'spacing-alone', rules: [], config: { minTarget: 24, targetSpacing: true } },
  { page: 'spacing-crowded', rules: ['touch-target'], config: { minTarget: 24, targetSpacing: true } },
  { page: 'spacing-alone', rules: ['touch-target'], config: { minTarget: 24 } },
  { page: 'late', rules: ['touch-target'], target: /Late/ },
  { page: 'focus', rules: ['focus-visible'], target: /NoRing/, config: { focus: { enabled: true, limit: 10 } } },
];

for (const c of cases) {
  test(`심은 차이를 잡는다: ${c.page}${c.config ? ` ${JSON.stringify(c.config)}` : ''}`, async ({ page }) => {
    await page.goto(`${origin}/${c.page}.html`);
    const [r] = await inspect(page, c.page, { outDir, configPath: NO_CONFIG, config: c.config });
    expect(r.status, r.reason).toBe('inspected');
    expect(r.tokens).toBeGreaterThan(0);
    expect(rulesOf(r), JSON.stringify(r.findings, null, 2)).toEqual([...c.rules].sort());
    if (c.target) expect(r.findings.some((f) => c.target!.test(f.target))).toBe(true);
  });
}

test('같은 화면을 다시 재면 같은 결과가 나온다', async ({ page }) => {
  await page.goto(`${origin}/clipped.html`);
  const [a] = await inspect(page, 'again', { outDir, configPath: NO_CONFIG });
  const [b] = await inspect(page, 'again', { outDir, configPath: NO_CONFIG });
  expect(b.findings).toEqual(a.findings);
});

test('이름 속 숫자가 바뀌어도 지문은 같다', async ({ page }) => {
  await page.goto(`${origin}/number-label.html`);
  const [a] = await inspect(page, 'number', { outDir, configPath: NO_CONFIG });
  await page.evaluate(() => (document.getElementById('alarm')!.textContent = 'Alarm 12'));
  const [b] = await inspect(page, 'number', { outDir, configPath: NO_CONFIG });
  expect(a.findings[0].target).not.toEqual(b.findings[0].target);
  expect(b.findings.map((f) => f.fingerprint)).toEqual(a.findings.map((f) => f.fingerprint));
});

test('로딩 표시가 사라지지 않으면 못 본 화면으로 남는다', async ({ page }) => {
  await page.goto(`${origin}/stuck.html`);
  const [r] = await inspect(page, 'stuck', { outDir, configPath: NO_CONFIG, config: { ready: { ...defaultConfig.ready, timeoutMs: 800 } } });
  expect(r.status).toBe('failed');
  expect(r.reason).toMatch(/사라지지 않았다/);
  expect(buildReport([r], defaultConfig, [], null, 'confirmed').pass).toBe(false);
});

test('테마마다 따로 재고 원래 테마로 돌려놓는다', async ({ page }) => {
  await page.goto(`${origin}/theme.html`);
  const themes = [
    { name: 'light', removeClass: ['dark'] },
    { name: 'dark', htmlClass: 'dark' },
  ];
  const results = await inspect(page, 'theme', {
    outDir,
    configPath: NO_CONFIG,
    config: { modes: { viewports: ['1024x768', '1280x1024'], themes } },
  });
  expect(results.map((r) => r.viewport)).toEqual(['1024x768 · light', '1024x768 · dark', '1280x1024 · light', '1280x1024 · dark']);
  expect(results.filter((r) => r.viewport.endsWith('dark')).every((r) => rulesOf(r).includes('contrast'))).toBe(true);
  expect(results.filter((r) => r.viewport.endsWith('light')).every((r) => r.findings.length === 0)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.className)).toBe('');
  expect(page.viewportSize()).toEqual({ width: 1024, height: 768 });
  const config = { ...defaultConfig, screens: ['theme'], modes: { viewports: ['1024x768', '1280x1024'], themes } };
  expect(buildReport(results.slice(0, 3), config, [], null, 'never').unseen.map((u) => u.viewport)).toEqual(['1280x1024 · dark']);
});

test('녹화한 API 응답을 재생하면 서버 값이 바뀌어도 같은 화면이 나온다', async ({ browser }) => {
  const har = path.join(outDir, 'api.har');
  apiLabel = 'recorded';
  const rec = await browser.newContext();
  const p1 = await rec.newPage();
  expect(await useApiArchive(p1, { har, mode: 'record' })).toBe('record');
  await p1.goto(`${origin}/api.html`);
  await expect(p1.locator('#out')).toHaveText('recorded');
  await rec.close();

  apiLabel = 'changed';
  const live = await browser.newContext();
  const p2 = await live.newPage();
  await p2.goto(`${origin}/api.html`);
  await expect(p2.locator('#out')).toHaveText('changed');
  await live.close();

  const rep = await browser.newContext();
  const p3 = await rep.newPage();
  await useApiArchive(p3, { har, mode: 'replay' });
  await p3.goto(`${origin}/api.html`);
  await expect(p3.locator('#out')).toHaveText('recorded');
  await rep.close();
});

test('설정에 있는데 열지 않은 화면은 통과로 치지 않는다', () => {
  const config = { ...defaultConfig, screens: ['홈', '복구'] };
  const home: ScreenResult = { screen: '홈', viewport: '1024x768', url: '', status: 'inspected', elements: 3, tokens: 4, findings: [], at: '' };
  const r = buildReport([home], config, [], null, 'confirmed');
  expect(r.pass).toBe(false);
  expect(r.unseen.map((u) => u.screen)).toEqual(['복구']);
});

test('작업 전부터 있던 차이와 결정으로 정리한 차이는 빠진다', async ({ page }) => {
  await page.goto(`${origin}/touch.html`);
  const [head] = await inspect(page, 'touch', { outDir, configPath: NO_CONFIG });
  const fp = head.findings[0].fingerprint;
  const withBase = buildReport([head], defaultConfig, [], [head], 'confirmed');
  expect(withBase.open).toEqual([]);
  expect(withBase.baseline).toHaveLength(1);
  const decided = buildReport([head], defaultConfig, [{ fingerprint: fp, decision: 'keep', reason: '합의' }], null, 'confirmed');
  expect(decided.open).toEqual([]);
  expect(decided.pass).toBe(true);
});

test('기준선이 merge-base 가 아니거나 커밋 안 된 변경이 섞이면 알린다', () => {
  const s = (commit: string, dirty: boolean): ScreenResult => ({
    screen: '홈',
    viewport: '1024x768',
    url: '',
    status: 'inspected',
    elements: 1,
    tokens: 1,
    findings: [],
    at: '',
    commit,
    dirty,
  });
  expect(buildReport([s('aaa1111', false)], defaultConfig, [], null, 'confirmed').notes).toEqual([
    '기준선 결과가 없어 작업 전부터 있던 차이를 빼지 않았다',
  ]);
  const r = buildReport([s('bbb2222', true)], defaultConfig, [], [s('ccc3333', false)], 'confirmed', {
    expectedBase: 'aaa1111',
    shallow: true,
  });
  expect(r.notes.join('\n')).toMatch(/얕은 clone/);
  expect(r.notes.join('\n')).toMatch(/merge-base aaa1111 가 아니라 ccc3333/);
  expect(r.notes.join('\n')).toMatch(/이번 결과에 커밋 안 된 변경/);
});
