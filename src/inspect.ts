import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Page } from '@playwright/test';

import { collectInPage } from './collect.ts';
import { apiFailures } from './har.ts';
import { focusDrafts, focusInPage, markFocusables, unmarkFocusables, type FocusVisit } from './focus.ts';
import { fingerprint, runRules } from './rules.ts';
import { defaultConfig, modeLabel, type PageSnapshot, type QaConfig, type ReadyConfig, type ScreenResult, type Theme } from './types.ts';

const FREEZE_CSS = `*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition-duration:0s!important;transition-delay:0s!important;caret-color:transparent!important}`;

export interface InspectOptions {
  outDir?: string;
  config?: Partial<QaConfig>;
  configPath?: string;
}

export async function loadConfig(configPath = process.env.UI_QA_CONFIG ?? 'ui-qa.config.json'): Promise<QaConfig> {
  try {
    const raw = JSON.parse(await readFile(configPath, 'utf8')) as Partial<QaConfig>;
    return mergeConfig(defaultConfig, raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ...defaultConfig };
    throw err;
  }
}

export function mergeConfig(base: QaConfig, over: Partial<QaConfig> = {}): QaConfig {
  return {
    ...base,
    ...over,
    ready: { ...base.ready, ...over.ready },
    modes: { ...base.modes, ...over.modes },
    focus: { ...base.focus, ...over.focus },
  };
}

let gitState: { commit?: string; dirty?: boolean } | null = null;

function readGit(): { commit?: string; dirty?: boolean } {
  if (gitState) return gitState;
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    gitState = { commit, dirty: status.trim().length > 0 };
  } catch {
    gitState = {};
  }
  return gitState;
}

function slug(text: string): string {
  return text.replace(/[\\/:*?"<>|\s·]+/g, '_');
}

function signature(snap: PageSnapshot): string {
  return JSON.stringify([snap.documentOverflow, snap.elements.map((e) => [e.rect, e.label])]);
}

async function stableSnapshot(page: Page, config: QaConfig): Promise<{ snap: PageSnapshot; stable: boolean }> {
  const args = { touchExempt: config.touchExempt, tokenExclude: config.tokenExclude };
  let prev = await page.evaluate(collectInPage, args);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const next = await page.evaluate(collectInPage, args);
    if (signature(next) === signature(prev)) return { snap: next, stable: true };
    prev = next;
  }
  return { snap: prev, stable: false };
}

async function waitReady(page: Page, ready: ReadyConfig): Promise<string | null> {
  for (const sel of ready.selectors) {
    try {
      await page.locator(sel).first().waitFor({ state: 'visible', timeout: ready.timeoutMs });
    } catch {
      return `준비 표시 「${sel}」이(가) ${ready.timeoutMs}ms 안에 나타나지 않았다`;
    }
  }
  if (ready.absent.length > 0) {
    try {
      await page.waitForFunction((sels) => sels.every((s) => document.querySelector(s) === null), ready.absent, {
        timeout: ready.timeoutMs,
      });
    } catch {
      const left = await page.evaluate((sels) => sels.filter((s) => document.querySelector(s) !== null), ready.absent);
      return `로딩 표시 「${left.join(', ')}」이(가) ${ready.timeoutMs}ms 안에 사라지지 않았다`;
    }
  }
  const quiet = await page.evaluate(
    ({ quietMs, timeoutMs }) =>
      new Promise<boolean>((resolve) => {
        let last = performance.now();
        const bump = () => {
          last = performance.now();
        };
        const mo = new MutationObserver(bump);
        mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
        let po: PerformanceObserver | null = null;
        try {
          po = new PerformanceObserver(bump);
          po.observe({ type: 'resource', buffered: false });
        } catch {
          po = null;
        }
        const start = performance.now();
        const tick = () => {
          const imagesDone = Array.from(document.images).every((img) => img.complete);
          if (!imagesDone) bump();
          const now = performance.now();
          if (now - last >= quietMs) {
            mo.disconnect();
            po?.disconnect();
            resolve(true);
          } else if (now - start >= timeoutMs) {
            mo.disconnect();
            po?.disconnect();
            resolve(false);
          } else setTimeout(tick, 50);
        };
        tick();
      }),
    { quietMs: ready.quietMs, timeoutMs: ready.timeoutMs },
  );
  return quiet ? null : `화면이 ${ready.timeoutMs}ms 안에 잠잠해지지 않았다 (DOM·네트워크·이미지)`;
}

async function applyTheme(page: Page, theme: Theme | null) {
  if (!theme) return;
  if (theme.colorScheme) await page.emulateMedia({ colorScheme: theme.colorScheme });
  await page.evaluate(
    ({ add, remove }) => {
      const root = document.documentElement;
      for (const c of remove) root.classList.remove(c);
      if (add) root.classList.add(add);
    },
    { add: theme.htmlClass ?? '', remove: theme.removeClass ?? [] },
  );
}

async function measureOnce(page: Page, screen: string, mode: string, config: QaConfig): Promise<ScreenResult> {
  const at = new Date().toISOString();
  const git = readGit();
  const style = await page.addStyleTag({ content: FREEZE_CSS }).catch(() => null);
  try {
    const notReady = await waitReady(page, config.ready);
    if (notReady && /나타나지|사라지지/.test(notReady))
      return { screen, viewport: mode, url: page.url(), status: 'failed', reason: notReady, elements: 0, tokens: 0, findings: [], at, ...git };
    const fontsLoaded = await page.evaluate(() => document.fonts.ready.then(() => document.fonts.status === 'loaded'));
    const { snap, stable } = await stableSnapshot(page, config);
    const findings = runRules(snap, config, screen, mode);
    if (config.focus.enabled) {
      await page.evaluate(markFocusables);
      const visits: FocusVisit[] = [];
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      for (let i = 0; i < config.focus.limit; i += 1) {
        await page.keyboard.press('Tab');
        const v = await page.evaluate(focusInPage);
        if (!v || visits.some((x) => x.mark === v.mark)) break;
        visits.push(v);
      }
      await page.evaluate(unmarkFocusables);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      for (const d of focusDrafts(visits)) {
        const f = { ...d, screen, viewport: mode };
        findings.push({ ...f, fingerprint: fingerprint(f) });
      }
    }
    const reason =
      notReady ??
      (!fontsLoaded ? '글꼴을 다 불러오기 전이라 대체 글꼴을 쟀을 수 있다' : !stable ? '측정을 다섯 번 되풀이해도 배치가 멈추지 않았다' : undefined);
    return {
      screen,
      viewport: mode,
      url: snap.url,
      status: reason ? 'unstable' : 'inspected',
      reason: reason ?? undefined,
      elements: snap.elements.length,
      tokens: snap.tokens.length,
      findings,
      at,
      ...git,
      apiFailures: apiFailures(page),
    };
  } catch (err) {
    const reason = (err as Error).message.split('\n')[0];
    return { screen, viewport: mode, url: page.url(), status: 'failed', reason, elements: 0, tokens: 0, findings: [], at, ...git };
  } finally {
    await style?.evaluate((node) => (node as Element).remove()).catch(() => undefined);
  }
}

export async function inspect(page: Page, screen: string, options: InspectOptions = {}): Promise<ScreenResult[]> {
  const config = mergeConfig(await loadConfig(options.configPath), options.config);
  const outDir = options.outDir ?? process.env.UI_QA_OUT ?? 'qa-out';
  const original = page.viewportSize();
  const current = original ? `${original.width}x${original.height}` : 'unknown';
  const viewports = config.modes.viewports.length > 0 ? config.modes.viewports : [current];
  const themes: (Theme | null)[] = config.modes.themes.length > 0 ? config.modes.themes : [null];
  const rootClass = await page.evaluate(() => document.documentElement.className);
  const results: ScreenResult[] = [];

  try {
    for (const vp of viewports) {
      if (vp !== current) {
        const [width, height] = vp.split('x').map(Number);
        await page.setViewportSize({ width, height });
      }
      for (const theme of themes) {
        await applyTheme(page, theme);
        results.push(await measureOnce(page, screen, modeLabel(vp, theme), config));
      }
    }
  } finally {
    if (original && viewports.some((v) => v !== current)) await page.setViewportSize(original);
    if (themes[0]) {
      await page.evaluate((cls) => (document.documentElement.className = cls), rootClass);
      await page.emulateMedia({ colorScheme: null });
    }
  }

  await mkdir(path.join(outDir, 'screens'), { recursive: true });
  for (const r of results)
    await writeFile(path.join(outDir, 'screens', `${slug(screen)}@${slug(r.viewport)}.json`), JSON.stringify(r, null, 2));
  return results;
}
