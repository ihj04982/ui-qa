#!/usr/bin/env -S npx tsx
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { chromium } from '@playwright/test';

import { inspect, loadConfig } from './inspect.ts';
import { buildReport, readDecisions, readScreens, writeReport, type FailOn } from './report.ts';

const USAGE = `ui-qa report [결과 폴더] [--base 폴더] [--decisions 파일] [--config 파일] [--fail-on confirmed|all|never] [--repo 폴더 --base-ref origin/dev]
ui-qa page <URL 또는 HTML 파일> --screen 이름 [--viewport 1024x768,1280x1024] [--out 폴더] [--wait 셀렉터]
ui-qa merge-base [--repo 폴더] [--base-ref origin/dev]`;

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function gitInfo(repo: string, baseRef: string) {
  const shallow = git(repo, ['rev-parse', '--is-shallow-repository']) === 'true';
  const head = git(repo, ['rev-parse', 'HEAD']);
  const dirty = git(repo, ['status', '--porcelain', '--untracked-files=no']).length > 0;
  let mergeBase: string | undefined;
  try {
    mergeBase = git(repo, ['merge-base', 'HEAD', baseRef]);
  } catch {
    mergeBase = undefined;
  }
  return { head, mergeBase, shallow, dirty };
}

async function report(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      base: { type: 'string' },
      decisions: { type: 'string', default: 'decisions.yaml' },
      config: { type: 'string' },
      'fail-on': { type: 'string', default: 'confirmed' },
      repo: { type: 'string', default: '.' },
      'base-ref': { type: 'string' },
    },
  });
  const dir = positionals[0] ?? process.env.UI_QA_OUT ?? 'qa-out';
  const config = await loadConfig(values.config);
  const screens = await readScreens(dir);
  const base = values.base ? await readScreens(values.base) : null;
  const decisions = await readDecisions(values.decisions);
  const info = values['base-ref'] ? gitInfo(values.repo, values['base-ref']) : null;
  const r = buildReport(screens, config, decisions, base, values['fail-on'] as FailOn, {
    expectedBase: info?.mergeBase,
    shallow: info ? info.shallow || !info.mergeBase : false,
  });
  process.stdout.write(await writeReport(dir, r));
  process.exitCode = r.pass ? 0 : 1;
}

async function mergeBase(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: { repo: { type: 'string', default: '.' }, 'base-ref': { type: 'string', default: 'origin/dev' } },
  });
  const info = gitInfo(values.repo, values['base-ref']);
  process.stdout.write(`${JSON.stringify(info)}\n`);
  process.exitCode = info.mergeBase && !info.shallow ? 0 : 1;
}

async function page(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      screen: { type: 'string' },
      viewport: { type: 'string', default: '1024x768' },
      out: { type: 'string' },
      config: { type: 'string' },
      wait: { type: 'string' },
    },
  });
  const target = positionals[0];
  if (!target || !values.screen) throw new Error(USAGE);
  const url = /^https?:|^file:/.test(target) ? target : pathToFileURL(path.resolve(target)).href;
  if (url.startsWith('file:') && !existsSync(new URL(url))) throw new Error(`파일이 없다: ${target}`);
  const browser = await chromium.launch();
  try {
    for (const vp of values.viewport.split(',')) {
      const [width, height] = vp.split('x').map(Number);
      const ctx = await browser.newContext({ viewport: { width, height }, locale: 'ko-KR', deviceScaleFactor: 1 });
      const p = await ctx.newPage();
      await p.goto(url, { waitUntil: 'networkidle' });
      if (values.wait) await p.locator(values.wait).first().waitFor();
      for (const r of await inspect(p, values.screen, { outDir: values.out, configPath: values.config }))
        process.stdout.write(`「${r.screen}」 ${r.viewport}: ${r.status}, 발견 ${r.findings.length}\n`);
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
}

const [cmd, ...rest] = process.argv.slice(2);
const commands: Record<string, (argv: string[]) => Promise<void>> = { report, page, 'merge-base': mergeBase };
const run = commands[cmd];
if (!run) {
  process.stderr.write(`${USAGE}\n`);
  process.exitCode = 2;
} else {
  run(rest).catch((err: Error) => {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 2;
  });
}
