# 决策后悔模拟器 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付录入 2–4 个决策选项、配置价值观、生成时间维度后悔预演与曲线并给出可解释建议的纯前端应用。

**Architecture:** 核心层以纯函数完成校验、权重归一化、指数计算、模板生成和排序；端口隔离案例存储与打印；Vue 使用分步控制器管理草稿、过期结果和保存案例。SVG 曲线只渲染核心分析结果，不重复计算业务规则。

**Tech Stack:** Vue 3, TypeScript, Vite, Vitest, Vue Test Utils, inline SVG, native CSS, Nginx

**Spec:** `docs/superpowers/specs/2026-10-05-decision-regret-simulator-design.md`

## Global Constraints

- 选项数量固定为 2–4 个；影响值范围为 -5 到 +5。
- 后悔指数必须位于 0–100，计算透明、确定且无需远程 AI。
- 核心层不得读取 DOM、localStorage 或系统时间。
- 所有建议保持非命令式，并对高风险主题追加专业咨询提示。
- Docker 生产端口映射固定为 `8106:80`。

## Review Focus

- 四项原始权重全为零：Task 2 测试必须返回校验错误而非 NaN。
- 两个方案总分差值恰好为 5：Task 3 测试必须给出明确胜者，只有小于 5 才提示接近。
- 影响值越界：Task 2 测试必须拒绝分析并指出具体选项和维度。
- localStorage 中为旧版本或损坏数据：Task 4 测试必须回退且不覆盖当前草稿。
- 标题含医疗/法律/投资高风险词：Task 3 测试必须追加对应专业咨询提示。

---

### Task 1: 工程骨架与领域模型

**Files:**
- Create: `package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `src/main.ts`, `src/vite-env.d.ts`
- Create: `src/core/models.ts`, `src/core/__tests__/models.test.ts`
- Create: `.gitignore`, `.dockerignore`

**Interfaces:**
- Produces: `ValueKey`, `ValueWeights`, `DecisionOption`, `DecisionDraft`, `Horizon`, `RegretPoint`, `RehearsalCard`, `OptionAnalysis`, `DecisionAnalysis`, `SavedCase`.

- [ ] **Step 1: Write the failing model test** that constructs a valid 2-option draft and verifies horizon constants `[1,5,10]` and value keys.
- [ ] **Step 2: Run the model test** and confirm missing module failure.
- [ ] **Step 3: Add Vite/Vitest/Vue configuration and implement exact domain types/constants.**
- [ ] **Step 4: Run `npm test -- models.test.ts` and `npm run build`**; both must exit 0.
- [ ] **Step 5: Commit** with `feat: scaffold regret simulator domain`.

### Task 2: 校验、价值权重与后悔指数

**Files:**
- Create: `src/core/validation.ts`, `src/core/weight-service.ts`, `src/core/regret-engine.ts`
- Test: `src/core/__tests__/validation.test.ts`, `weight-service.test.ts`, `regret-engine.test.ts`

**Interfaces:**
- Produces: `validateDraft(draft): ValidationIssue[]`, `normalizeWeights(weights): NormalizedWeights`, `scoreOption(option,weights,horizon): RegretPoint`.

- [ ] **Step 1: Write failing validation tests** for fewer than 2/more than 4 options, blank names, duplicate names, -5/+5 accepted, out-of-range rejected with option/value path.
- [ ] **Step 2: Implement validation and run its test to green.**
- [ ] **Step 3: Write failing weight tests** for sum-to-100 normalization, equal weights, preset weights and all-zero error with finite outputs.
- [ ] **Step 4: Implement normalization/presets and run weight tests to green.**
- [ ] **Step 5: Write failing scoring tests** for 0–100 bounds, stable repeated results, short-term stability emphasis, long-term growth/free emphasis and score breakdown summing to total.
- [ ] **Step 6: Implement the documented time modifiers and weighted penalties.**
- [ ] **Step 7: Run the full suite** and confirm zero failures.
- [ ] **Step 8: Commit** with `feat: add regret scoring model`.

### Task 3: 预演文本、分析编排与建议

**Files:**
- Create: `src/core/rehearsal-engine.ts`, `src/core/analysis-service.ts`, `src/core/safety-notice.ts`, `src/core/sample-data.ts`
- Test: `src/core/__tests__/rehearsal-engine.test.ts`, `analysis-service.test.ts`, `safety-notice.test.ts`

**Interfaces:**
- Produces: `createRehearsal(option,weights,point): RehearsalCard`, `analyzeDecision(draft): DecisionAnalysis`, `safetyNoticesFor(text): string[]`, `sampleDrafts`.

- [ ] **Step 1: Write failing rehearsal tests** that highest-weight negative dimension drives regret text, cards contain trigger/reversibility/action, and all horizons are represented.
- [ ] **Step 2: Implement dimension templates and run rehearsal tests to green.**
- [ ] **Step 3: Write failing analysis tests** for 30/40/30 total weighting, lowest total recommendation, `<5` close-result message, exact-5 winner and immutable inputs.
- [ ] **Step 4: Implement analysis orchestration and run tests to green.**
- [ ] **Step 5: Write failing safety tests** for medical, legal and investment Chinese/English keywords plus ordinary decision no-warning case.
- [ ] **Step 6: Implement non-blocking professional-consultation notices and sample decisions.**
- [ ] **Step 7: Run the full suite** and confirm zero failures.
- [ ] **Step 8: Commit** with `feat: add regret rehearsal and recommendations`.

### Task 4: 案例仓储、打印与分步控制器

**Files:**
- Create: `src/ports/case-repository.port.ts`, `src/ports/print.port.ts`
- Create: `src/adapters/local-case.repository.ts`, `src/adapters/browser-print.adapter.ts`
- Create: `src/ui/useDecisionStudio.ts`
- Test: `src/adapters/__tests__/local-case.repository.test.ts`, `src/ui/__tests__/useDecisionStudio.test.ts`

**Interfaces:**
- Produces: repository list/get/save/delete; `PrintPort.print()`; controller actions for navigation, option CRUD, presets, analyze, save, duplicate, delete and restore.

- [ ] **Step 1: Write failing repository tests** for round trip, schema version, malformed/old data fallback and preservation of unrelated storage keys.
- [ ] **Step 2: Implement the port and localStorage adapter; run repository tests to green.**
- [ ] **Step 3: Write failing controller tests** for step gating, 2–4 option bounds, analysis creation, edit-after-analysis marks stale, save/restore, duplicate and confirmed delete.
- [ ] **Step 4: Implement the controller and injected print adapter.**
- [ ] **Step 5: Run controller and full tests** and confirm zero failures.
- [ ] **Step 6: Commit** with `feat: add decision case workflow`.

### Task 5: Vue 分步界面、预演卡和 SVG 曲线

**Files:**
- Create: `src/ui/App.vue`, `src/ui/components/DecisionBasics.vue`, `OptionEditor.vue`, `ValuesPanel.vue`, `RehearsalBoard.vue`, `RegretCurve.vue`, `RecommendationPanel.vue`, `CaseLibrary.vue`, `PrintReport.vue`
- Create: `src/ui/styles.css`
- Test: `src/ui/__tests__/App.test.ts`, `src/ui/__tests__/RegretCurve.test.ts`

**Interfaces:**
- Consumes: `useDecisionStudio`; curve accepts `OptionAnalysis[]`, hidden option ids and emits legend toggles.

- [ ] **Step 1: Write failing App tests** for sample load, option add/remove bounds, zero-weight error, preset selection, analyze, stale banner, save and case restore.
- [ ] **Step 2: Run the App test** and confirm missing components fail.
- [ ] **Step 3: Implement the responsive step interface, result dashboard and native-CSS archive visual system.**
- [ ] **Step 4: Write failing curve tests** for three x positions, bounded y coordinates, legend toggle, accessible labels and point details.
- [ ] **Step 5: Implement SVG paths/points and run curve/App/full tests to green.**
- [ ] **Step 6: Add print report and assert print action plus safety notices in App tests.**
- [ ] **Step 7: Run `npm run build`** and confirm exit 0.
- [ ] **Step 8: Commit** with `feat: build regret simulation workspace`.

### Task 6: 容器化、文档与最终重构

**Files:**
- Create: `Dockerfile`, `docker-compose.yml`, `nginx.conf`, `README.md`
- Modify: files identified by cohesion review only within this project.

**Interfaces:**
- Produces: reproducible Nginx image and documented scoring/privacy/limitation details.

- [ ] **Step 1: Review dependency directions, calculation duplication and component responsibilities; add or adjust tests before behavior-preserving extraction.**
- [ ] **Step 2: Refactor to keep all scoring only in core and all persistence only in adapters; run full tests.**
- [ ] **Step 3: Add multi-stage Docker/Nginx files and README commands, architecture, scoring explanation, privacy and disclaimer.**
- [ ] **Step 4: Run `npm test`, `npm run build`, and `docker build -t c2c-006 .`**; all must exit 0.
- [ ] **Step 5: Inspect `git diff --check` and `git status --short`.**
- [ ] **Step 6: Commit** with `chore: finalize regret simulator delivery`.
