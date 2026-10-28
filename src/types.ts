export type Verdict = 'confirmed' | 'needs_review';

export type Rgba = [number, number, number, number];

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Clip {
  by: number;
  axis: 'x' | 'y';
  over: number;
}

export interface ElementRecord {
  i: number;
  parent: number | null;
  tag: string;
  role: string | null;
  label: string;
  hint: string;
  ownText: string;
  interactive: boolean;
  disabled: boolean;
  touchExempt: boolean;
  fixed: boolean;
  rect: Rect;
  color: Rgba | null;
  background: Rgba | null;
  border: Rgba | null;
  fontFamily: string;
  fontWeight: number;
  fontStyle: string;
  fontSize: number;
  overflowX: string;
  ellipsis: boolean;
  scroll: { sw: number; cw: number };
  clip: Clip | null;
  offscreen: { axis: 'x' | 'y'; over: number } | null;
}

export interface FontFaceRecord {
  family: string;
  weight: string;
  style: string;
  status: string;
}

export interface TokenRecord {
  name: string;
  rgba: Rgba;
}

export interface PageSnapshot {
  pageBackground: Rgba;
  url: string;
  viewport: { width: number; height: number };
  documentOverflow: { x: number; y: number };
  elements: ElementRecord[];
  fonts: FontFaceRecord[];
  tokens: TokenRecord[];
  tokenSheetsUnreadable: number;
}

export interface Finding {
  rule: string;
  verdict: Verdict;
  screen: string;
  viewport: string;
  target: string;
  hint?: string;
  property: string;
  actual: string;
  expected: string;
  note?: string;
  count?: number;
  fingerprint: string;
}

export type CoverageStatus = 'inspected' | 'unstable' | 'failed';

export interface ScreenResult {
  screen: string;
  viewport: string;
  url: string;
  status: CoverageStatus;
  reason?: string;
  elements: number;
  tokens: number;
  findings: Finding[];
  at: string;
  commit?: string;
  dirty?: boolean;
  apiFailures?: string[];
}

export interface Theme {
  name: string;
  htmlClass?: string;
  removeClass?: string[];
  colorScheme?: 'light' | 'dark';
}

export interface ReadyConfig {
  selectors: string[];
  absent: string[];
  quietMs: number;
  timeoutMs: number;
}

export interface QaConfig {
  minTarget: number;
  screens: string[];
  viewports: string[];
  tokenExclude: string[];
  systemFonts: string[];
  touchExempt: string[];
  targetSpacing: boolean;
  ready: ReadyConfig;
  modes: { viewports: string[]; themes: Theme[] };
  focus: { enabled: boolean; limit: number };
}

export const defaultConfig: QaConfig = {
  minTarget: 48,
  screens: [],
  viewports: [],
  tokenExclude: ['^--color-[a-z]+-\\d{2,3}$', '^--tw-'],
  systemFonts: [
    'serif',
    'sans-serif',
    'monospace',
    'cursive',
    'fantasy',
    'system-ui',
    'ui-sans-serif',
    'ui-serif',
    'ui-monospace',
    '-apple-system',
    'blinkmacsystemfont',
    'segoe ui',
    'arial',
    'helvetica',
  ],
  touchExempt: [],
  targetSpacing: false,
  ready: { selectors: [], absent: ['[aria-busy="true"]'], quietMs: 400, timeoutMs: 10_000 },
  modes: { viewports: [], themes: [] },
  focus: { enabled: false, limit: 40 },
};

export function modeLabel(viewport: string, theme: Theme | null): string {
  return theme ? `${viewport} · ${theme.name}` : viewport;
}
