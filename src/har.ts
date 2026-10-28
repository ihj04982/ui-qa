import type { Page } from '@playwright/test';

export type ApiMode = 'live' | 'record' | 'replay';

export interface ApiArchiveOptions {
  har: string;
  mode?: ApiMode;
  api?: RegExp;
  stream?: RegExp;
}

// SSE 는 HAR 로 담기지 않으므로 재생 때는 열어 두기만 하고, retry 를 길게 줘 다시 붙지 않게 한다.
const HOLD_STREAM = 'retry: 3600000\n\n';

const failures = new WeakMap<Page, Set<string>>();

export function watchApiFailures(page: Page, api: RegExp = /\/api\//) {
  if (failures.has(page)) return;
  const seen = new Set<string>();
  failures.set(page, seen);
  page.on('response', (res) => {
    if (res.status() < 500 || !api.test(res.url())) return;
    const u = new URL(res.url());
    seen.add(`${res.request().method()} ${u.pathname} ${res.status()}`);
  });
}

export function apiFailures(page: Page): string[] {
  return [...(failures.get(page) ?? [])].sort();
}

export async function useApiArchive(page: Page, options: ApiArchiveOptions): Promise<ApiMode> {
  const mode = options.mode ?? ((process.env.UI_QA_API as ApiMode | undefined) || 'live');
  const api = options.api ?? /\/api\//;
  watchApiFailures(page, api);
  if (mode === 'live') return mode;
  const stream = options.stream ?? /\/api\/events/;
  const url = new RegExp(`^(?!.*(?:${stream.source})).*${api.source}`);
  if (mode === 'record') {
    await page.routeFromHAR(options.har, { url, update: true, updateContent: 'embed', updateMode: 'minimal' });
    return mode;
  }
  await page.route(stream, (route) =>
    route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: HOLD_STREAM }),
  );
  await page.routeFromHAR(options.har, { url, notFound: 'abort' });
  return mode;
}
