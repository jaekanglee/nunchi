# 자동 전송 기준 프리셋 칩 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 자동 전송 기준 숫자 세 개(autoMaxRisk · escalateRisk · autoMinConfidence)를 `신중` `보통` `적극` `직접 설정` 칩으로 고르게 한다.

**Architecture:** 프리셋은 `src/ctl/settings.ts`에 정의하고(보통 = 기본값), `main.ts`의 `state:get`으로 화면에 넘긴다. 화면(`static/index.html`)은 저장된 세 값으로 선택된 칩을 정하고, 칩을 누르면 기존 `api.setSetting`으로 세 값을 저장한다. 새 설정 키·엔진 변경은 없다.

**Tech Stack:** TypeScript (Electron main), node:test, 정적 HTML + 바닐라 JS

**Spec:** `docs/superpowers/specs/2026-10-26-risk-presets-design.md`

**주의:** 실사용 앱이 자동 전송 모드로 돌고 있다. 검증 중에 앱을 띄우거나 재시작하지 말 것. 화면 확인은 사용자가 한다.

---

### Task 1: 프리셋 정의 + 테스트

**Files:**
- Modify: `src/ctl/settings.ts` (`SETTINGS` 정의 바로 아래)
- Test: `src/ctl/settings.test.ts`

- [ ] **Step 1: 실패하는 테스트 작성** — `src/ctl/settings.test.ts`의 import에 `RISK_PRESETS`를 추가하고 맨 아래에 붙인다.

```ts
test('자동 전송 프리셋: 보통은 기본값, 값은 설정 범위 안, 신중→적극으로 느슨해짐', () => {
  assert.deepEqual(RISK_PRESETS.map((p) => p.label), ['신중', '보통', '적극']);
  const [careful, normal, bold] = RISK_PRESETS;
  for (const [k, v] of Object.entries(normal.values)) assert.equal(v, SETTINGS[k].fallback, k);
  for (const p of RISK_PRESETS) {
    for (const [k, v] of Object.entries(p.values)) assert.equal(validateSetting(k, v), null, `${p.label} ${k}`);
    assert.ok(Number(p.values.autoMaxRisk) <= Number(p.values.escalateRisk), p.label);
  }
  for (const [a, b] of [[careful, normal], [normal, bold]]) {
    assert.ok(Number(a.values.autoMaxRisk) < Number(b.values.autoMaxRisk));
    assert.ok(Number(a.values.escalateRisk) < Number(b.values.escalateRisk));
    assert.ok(Number(a.values.autoMinConfidence) > Number(b.values.autoMinConfidence));
  }
});
```

- [ ] **Step 2: 실패 확인** — Run: `npm test` / Expected: tsc 에러 `has no exported member 'RISK_PRESETS'`

- [ ] **Step 3: 구현** — `src/ctl/settings.ts`의 `SETTINGS` 닫는 `};` 바로 아래에 추가.

```ts
// 자동 전송 기준 프리셋 (설정 화면의 칩). 값은 설정 저장 단위(확신은 %). 보통은 기본값을 따라간다
type RiskValues = { autoMaxRisk: string; escalateRisk: string; autoMinConfidence: string };
export const RISK_PRESETS: { id: string; label: string; desc: string; values: RiskValues }[] = [
  { id: 'careful', label: '신중', desc: '확실히 안전한 것만 보내고, 조금만 애매해도 알립니다', values: { autoMaxRisk: '10', escalateRisk: '40', autoMinConfidence: '90' } },
  {
    id: 'normal', label: '보통', desc: '가벼운 답장은 보내고, 위험해 보이면 알립니다',
    values: { autoMaxRisk: SETTINGS.autoMaxRisk.fallback, escalateRisk: SETTINGS.escalateRisk.fallback, autoMinConfidence: SETTINGS.autoMinConfidence.fallback },
  },
  { id: 'bold', label: '적극', desc: '웬만한 건 보내고, 정말 위험할 때만 알립니다', values: { autoMaxRisk: '35', escalateRisk: '75', autoMinConfidence: '70' } },
];
```

- [ ] **Step 4: 통과 확인** — Run: `npm test` / Expected: 전체 PASS

- [ ] **Step 5: 커밋** — `git add src/ctl/settings.ts src/ctl/settings.test.ts && git commit -m "feat: 자동 전송 기준 프리셋 정의"`

### Task 2: 화면 state로 넘기기

**Files:**
- Modify: `src/main.ts:11` (import), `src/main.ts:50` 부근 (`state:get`)

- [ ] **Step 1:** import에 `RISK_PRESETS` 추가: `import { RISK_PRESETS, SETTINGS, parseDirs, parseGroups, parseKeywordMap, validateSetting } from './ctl/settings.js';`
- [ ] **Step 2:** `autoEligible: AUTO_ELIGIBLE,` 다음 줄에 `riskPresets: RISK_PRESETS,` 추가
- [ ] **Step 3:** Run: `npm test` / Expected: PASS
- [ ] **Step 4:** 커밋 — `git commit -am "feat: 자동 전송 프리셋을 화면 state로 전달"`

### Task 3: 설정 화면 칩

**Files:**
- Modify: `static/index.html` — CSS(`#settings .numbox` 근처), 자동 전송 카드 마크업(430~437행), `refreshNow()`, `renderRiskZones()` 근처, `renderMenuSummaries()`의 `replySummary`

- [ ] **Step 1: CSS** — `#settings .numbox input {…}` 다음 줄에 추가.

```css
    .presets { display: flex; flex-wrap: wrap; gap: 6px; margin: 4px 0 6px; }
    .presets button { border: 1px solid var(--line); background: var(--panel); color: var(--text); border-radius: 999px; padding: 5px 14px; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
    .presets button.on { background: var(--brand-soft); border-color: var(--brand); color: var(--brand); }
```

- [ ] **Step 2: 마크업** — 카드 설명(430행)을 줄이고, 숫자 세 줄(435~437행)을 칩 + 접히는 영역으로 바꾼다.

430행 교체:
```html
        <div class="hint">초안마다 모델이 매긴 위험·확신 점수로 자동으로 보낼지 정합니다. 업무지시·결정, 장애·긴급, 민감은 점수와 상관없이 항상 직접 확인합니다.</div>
```
435~437행 교체:
```html
        <div class="srow"><div><b>얼마나 맡길까요</b><small id="riskPresetDesc"></small></div></div>
        <div class="presets" id="riskPresets"></div>
        <div id="riskCustom" hidden>
          <div class="hint">초안마다 모델이 점수 두 개를 매깁니다. <b>위험</b>(0~100)은 확인 없이 보냈을 때 문제가 될 가능성, <b>확신</b>(0~100%)은 초안이 내 말투·의도에 맞을 가능성입니다. 두 점수는 합치거나 곱하지 않고 아래 기준과 하나씩 비교합니다.</div>
          (기존 435~437행 srow 세 줄 그대로)
        </div>
```

- [ ] **Step 3: 렌더·저장 JS** — `renderRiskZones()` 함수 위에 추가.

```js
    // 자동 전송 기준 프리셋 칩. 세 값이 모두 같은 프리셋을 고르고, 없거나 '직접 설정'을 누른 동안은 숫자 입력을 펼친다
    let riskCustom = false;
    let riskApplying = null; // 저장 중인 프리셋 id. 값이 하나씩 바뀌는 동안 칩이 '직접 설정'으로 깜빡이지 않게
    const riskPresetOf = (s) => state.riskPresets.find((p) => Object.entries(p.values).every(([k, v]) => s[k] === v));
    function renderRiskPresets() {
      const id = riskApplying ?? (riskCustom ? null : riskPresetOf(state.settings)?.id ?? null);
      const picked = state.riskPresets.find((p) => p.id === id);
      const chip = (label, on, onclick) => el('button', { className: on ? 'on' : '', textContent: label, onclick });
      $('riskPresets').replaceChildren(
        ...state.riskPresets.map((p) => chip(p.label, p === picked, () => applyRiskPreset(p))),
        chip('직접 설정', !picked, () => { riskCustom = true; renderRiskPresets(); }));
      $('riskPresetDesc').textContent = picked ? picked.desc : '위험·확신 기준을 숫자로 직접 정합니다';
      $('riskCustom').hidden = !!picked;
    }
    async function applyRiskPreset(p) {
      riskApplying = p.id; riskCustom = false;
      renderRiskPresets();
      try { for (const [k, v] of Object.entries(p.values)) await api.setSetting(k, v); toast('저장했습니다. 다음 메시지부터 적용됩니다'); }
      catch (err) { toast(errText(err), 'err'); }
      finally { riskApplying = null; await refresh(); }
    }
```

- [ ] **Step 4: refreshNow에서 호출** — `renderRiskZones();` 바로 위에 `renderRiskPresets();` 추가.

- [ ] **Step 5: 요약 문구** — `replySummary`의 `· 위험 ${s.autoMaxRisk} 미만` 부분을 프리셋 이름으로.

```js
          : targets.length ? `자동 전송: ${where}카테고리 ${cats}개 · ${riskPresetOf(s)?.label ?? `위험 ${s.autoMaxRisk} 미만`}` : '자동 전송할 대화 없음',
```

- [ ] **Step 6: 검증** — Run: `npm test` / Expected: PASS. 인라인 스크립트 문법 확인:
  `node -e "const h=require('fs').readFileSync('static/index.html','utf8');const m=[...h.matchAll(/<script>([\s\S]*?)<\/script>/g)];for(const s of m)new Function(s[1]);console.log('ok',m.length)"`
  Expected: `ok N`

- [ ] **Step 7: 커밋** — `git commit -am "feat: 자동 전송 기준을 신중·보통·적극 칩으로 고르기"`

### Task 4: 사용자 확인

- [ ] 사용자에게 `nunchi` 재시작 후 설정 → 응답 · 자동 전송에서 확인할 것 안내: 지금 값(기본값이면 「보통」)이 선택돼 보이는지, 칩을 바꾸면 '지금 설정이면' 안내와 설정 첫 화면 요약이 바뀌는지, 「직접 설정」에서 숫자 입력이 펼쳐지는지.
