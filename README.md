# ui-qa

실브라우저에서 화면을 재어 규칙으로 판정한다. 판정에 AI 를 쓰지 않으므로 같은 화면은 늘 같은 결과가 나온다.

| 규칙 | 판정 | 잡는 것 |
|---|---|---|
| `document-overflow` | 확인됨 | 문서에 스크롤이 생김 |
| `offscreen` | 확인됨 | 스크롤로도 닿지 않는 화면 밖 요소 |
| `clipped` | 확인됨 | `overflow-hidden` 조상에 가려진 요소. 문서 스크롤이 안 생겨 기존 넘침 검사를 통과하는 경우 |
| `text-truncated` | 확인 필요 | 글자가 상자 밖으로 잘림 |
| `touch-target` | 확인됨 | 누르는 요소가 `minTarget`(기본 48px)보다 작음 |
| `font-face` | 확인됨 | 쓰는 굵기의 글꼴 파일이 없어 다른 굵기로 그려짐 |
| `color-token` | 확인 필요 | `:root` 변수에 없는 색 |
| `contrast` | 확인 필요 | 글자 대비 4.5:1(큰 글자 3:1) 미만. 비활성 요소는 뺀다 |
| `focus-visible` | 확인됨 / 확인 필요 | Tab 포커스에 모양 변화가 없음 / 포커스 테두리 대비 3:1 미만 |

## e2e 시나리오에 붙이기

```ts
import { inspect } from 'ui-qa';

await openApp(page, api);
await inspect(page, '홈');
```

결과는 `UI_QA_OUT`(기본 `qa-out`)/screens 에 화면별 JSON 으로 쌓인다.

```sh
npx ui-qa report qa-out --base qa-base --decisions decisions.yaml
```

- `--base`: 브랜치가 갈라진 커밋(`git merge-base`)에서 같은 시나리오를 돌린 결과. 그때도 있던 차이는 뺀다.
- `--decisions`: 고치지 않기로 한 항목.
- `--fail-on`: `confirmed`(기본) · `all` · `never`.
- `ui-qa.config.json` 의 `screens` 에 적은 화면이 결과에 없으면 「못 본 화면」으로 남고 통과로 치지 않는다.

```yaml
- fingerprint: e88411cff8e4
  decision: keep          # keep = 이대로 둔다, false_positive = 검사가 틀렸다
  reason: 디자인과 합의한 말줄임
  date: 2026-10-28
```

## 설정 (`ui-qa.config.json`)

```json
{
  "minTarget": 24,
  "targetSpacing": true,
  "screens": ["홈", "복구"],
  "modes": {
    "viewports": ["1440x900", "1920x1080"],
    "themes": [{ "name": "light", "removeClass": ["dark"] }, { "name": "dark", "htmlClass": "dark" }]
  },
  "ready": { "selectors": ["main"], "absent": ["[aria-busy=\"true\"]", ".animate-spin"], "quietMs": 400, "timeoutMs": 10000 },
  "focus": { "enabled": true, "limit": 40 }
}
```

- `modes`: `inspect()` 한 번에 판 크기 × 테마마다 잰다. 결과의 판 이름은 `1440x900 · dark` 꼴이고, `screens` × `modes` 중 빠진 판은 「못 본 화면」이 된다.
- `ready`: `selectors` 가 보이고 `absent` 가 사라지고 DOM·네트워크·이미지가 `quietMs` 동안 잠잠해진 뒤에 잰다. 앞 둘을 못 채우면 그 판은 「못 본 화면」, 잠잠해지지 않으면 「불안정」.
- `focus`: Tab 으로 `limit` 개까지 옮기며 포커스 전후 모양이 바뀌는지, 테두리 대비가 3:1 이상인지 본다(`focus-visible`).
- `targetSpacing`: WCAG 2.2 간격 예외. 작아도 `minTarget` 안에 다른 누르는 요소가 없으면 통과. 키오스크는 끈다.
- 지문(fingerprint)은 대상 이름 속 숫자를 `N` 으로 바꿔 만든다. 「인터락 0」이 「인터락 4」가 돼도 decisions.yaml·기준선 대조가 이어진다.

## API 녹화·재생

```ts
import { useApiArchive } from 'ui-qa';

await useApiArchive(page, { har: 'har/home.har' }); // UI_QA_API=record|replay|live (기본 live)
await page.goto('/');
```

`record` 는 `/api/` 응답을 HAR 로 남기고, `replay` 는 백엔드 없이 그 응답으로 띄운다. `/api/events`(SSE) 는 담지 않고 재생 때 열어 두기만 한다. 어느 모드든 5xx 응답이 있었으면 리포트 머리에 「오류 상태 화면일 수 있다」가 붙는다.

## 기준선

결과마다 `commit`·`dirty`(커밋 안 된 변경)가 남는다. `ui-qa report --base qa-base --repo . --base-ref origin/dev` 는 기준선이 merge-base 에서 만들어졌는지, 얕은 clone 인지 확인해 리포트 머리에 알린다. CI 에서는 `ui-qa merge-base` 로 기준 커밋을 구해 그 커밋에서 같은 시나리오를 돌리고, checkout 은 `fetch-depth: 0` 으로 한다.

## 목업 HTML 재기

```sh
npx ui-qa page ./board.html --screen 홈 --viewport 1024x768,1280x1024
```

## 검사 검사하기

`npm run selftest` 는 `selftest/fixtures` 의 일부러 틀린 화면마다 기대한 규칙만 나오는지, 깨끗한 화면에서 아무것도 안 나오는지, 같은 화면을 다시 재면 같은 결과인지 본다. 규칙을 고칠 때마다 돌린다.
