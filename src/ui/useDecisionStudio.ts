import { reactive, ref } from 'vue';
import { analyzeDecision } from '../core/analysis-service';
import { createSampleDraft } from '../core/sample-data';
import { validateDraft } from '../core/validation';
import {
  analyzeAt,
  quantizeBase,
  reweight,
  runSensitivity,
  type AdjustmentMode,
  type ProbeResult,
  type ScanStrategy,
  type SensitivityReport,
} from '../core/sensitivity-service';
import type { ValueKey } from '../core/models';
import type {
  DecisionAnalysis,
  DecisionDraft,
  DecisionOption,
  SavedCase,
  ValueWeights,
} from '../core/models';
import type { CaseRepository } from '../ports/case-repository.port';
import type { PrintPort } from '../ports/print.port';

export function useDecisionStudio(repository: CaseRepository, printer: PrintPort) {
  const draft = reactive<DecisionDraft>(createSampleDraft());
  const analysis = ref<DecisionAnalysis>();
  const errors = ref<string[]>([]);
  const stale = ref(false);
  const cases = ref<SavedCase[]>(repository.list());

  // 敏感性报告基于某一版本的方案；任何方案编辑都会使版本号前进、旧报告失效
  const sensitivityVersion = ref(0);
  const sensitivity = ref<{ report: SensitivityReport }>();
  const probe = ref<ProbeResult & { mode: AdjustmentMode; dimension: ValueKey }>();

  const touch = () => {
    stale.value = Boolean(analysis.value);
    draft.updatedAt = new Date().toISOString();
    sensitivityVersion.value += 1;
  };

  function setWeights(weights: ValueWeights) {
    draft.weights = { ...weights };
    touch();
  }

  function addOption() {
    if (draft.options.length >= 4) return;
    draft.options.push({
      id: `option-${Date.now()}`,
      name: '新选项',
      description: '',
      impacts: { stability: 0, growth: 0, freedom: 0, money: 0 },
      reversibility: 70,
    });
    touch();
  }

  function removeOption(id: string) {
    if (draft.options.length <= 2) return;
    draft.options = draft.options.filter((o) => o.id !== id);
    touch();
  }

  function updateOption(id: string, patch: Partial<DecisionOption>) {
    const target = draft.options.find((o) => o.id === id);
    if (target) Object.assign(target, patch);
    touch();
  }

  function analyze() {
    errors.value = validateDraft(draft);
    if (errors.value.length) return;
    analysis.value = analyzeDecision(draft);
    stale.value = false;
    sensitivityVersion.value += 1;
    probe.value = undefined;
  }

  function save() {
    repository.save({ draft: JSON.parse(JSON.stringify(draft)), analysis: analysis.value });
    cases.value = repository.list();
  }

  function load(item: SavedCase) {
    Object.assign(draft, JSON.parse(JSON.stringify(item.draft)));
    analysis.value = item.analysis;
    stale.value = false;
    sensitivity.value = undefined;
    probe.value = undefined;
    sensitivityVersion.value += 1;
  }

  function remove(id: string) {
    repository.delete(id);
    cases.value = repository.list();
  }

  function generateSensitivity(dimension: ValueKey, mode: AdjustmentMode, strategy: ScanStrategy) {
    const errorsNow = validateDraft(draft);
    if (errorsNow.length) return;
    const version = sensitivityVersion.value;
    const report = runSensitivity(draft, dimension, mode, strategy, version);
    sensitivity.value = { report };
    probe.value = undefined;
  }

  /** 临时套用某个权重位置进行对比：只复算，不写回方案权重。 */
  function previewProbe(dimension: ValueKey, mode: AdjustmentMode, index: number) {
    const base = quantizeBase(draft.weights);
    const result = analyzeAt(draft, base, dimension, index, mode);
    probe.value = { ...result, mode, dimension };
  }

  function clearProbe() {
    probe.value = undefined;
  }

  /** 用户确认后才把试探权重应用为新权重并重新推演；旧敏感性结果随之失效。 */
  function applyProbe() {
    if (!probe.value) return;
    setWeights(probe.value.weights);
    sensitivity.value = undefined;
    probe.value = undefined;
    analyze();
  }

  /** 试探滑杆在未生成报告时也可用：按当前基准即时再分配。 */
  function weightsAtProbe(dimension: ValueKey, mode: AdjustmentMode, index: number): ValueWeights {
    const base = quantizeBase(draft.weights);
    const tenths = reweight(base, dimension, Math.max(0, Math.min(1000, Math.round(index))), mode);
    return Object.fromEntries(Object.entries(tenths).map(([k, v]) => [k, v / 10])) as ValueWeights;
  }

  return {
    draft,
    analysis,
    errors,
    stale,
    cases,
    touch,
    setWeights,
    addOption,
    removeOption,
    updateOption,
    analyze,
    save,
    load,
    remove,
    sensitivityVersion,
    sensitivity,
    probe,
    generateSensitivity,
    previewProbe,
    clearProbe,
    applyProbe,
    weightsAtProbe,
    print: () => printer.print(),
  };
}
