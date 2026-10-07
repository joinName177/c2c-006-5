import { describe, expect, it } from 'vitest';
import { useDecisionStudio } from './useDecisionStudio';
import { LocalCaseRepository } from '../adapters/local-case.repository';
import { BrowserPrintAdapter } from '../adapters/browser-print.adapter';

function makeStudio() {
  const storage = new Map<string, string>();
  const repository = new LocalCaseRepository({
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
  } as unknown as Storage);
  return useDecisionStudio(repository, new BrowserPrintAdapter());
}

describe('敏感性交互契约', () => {
  it('生成报告后版本一致；试探不改写权重；应用才写回并重推', () => {
    const studio = makeStudio();
    const baseWeights = { ...studio.draft.weights };
    studio.analyze();
    expect(studio.errors.value).toEqual([]);
    const versionAfterAnalyze = studio.sensitivityVersion.value;

    studio.generateSensitivity('growth', 'proportional', 'adaptive');
    expect(studio.sensitivity.value).toBeTruthy();
    expect(studio.sensitivity.value!.report.version).toBe(versionAfterAnalyze);

    studio.previewProbe('growth', 'proportional', 900);
    expect(studio.probe.value).toBeTruthy();
    // 试探不覆盖方案权重
    expect(studio.draft.weights).toEqual(baseWeights);
    expect(studio.draft.weights.growth).toBeLessThan(90);

    studio.applyProbe();
    // 应用后权重写回为试探权重并重新推演
    expect(studio.draft.weights.growth).toBeCloseTo(90, 1);
    expect(studio.analysis.value).toBeTruthy();
    // 旧敏感性结果随版本前进失效（被清除，需重新生成）
    expect(studio.sensitivity.value).toBeUndefined();
    expect(studio.probe.value).toBeUndefined();
    expect(studio.sensitivityVersion.value).toBeGreaterThan(versionAfterAnalyze);
  });

  it('重新编辑方案后旧报告版本落后，判定为失效', () => {
    const studio = makeStudio();
    studio.analyze();
    studio.generateSensitivity('growth', 'proportional', 'adaptive');
    const reportVersion = studio.sensitivity.value!.report.version;

    studio.touch();
    // 报告对象保留以便面板展示“已失效”，但其版本号已落后
    expect(studio.sensitivity.value).toBeTruthy();
    expect(studio.sensitivity.value!.report.version).toBe(reportVersion);
    expect(reportVersion).toBeLessThan(studio.sensitivityVersion.value);
  });

  it('载入其他案例后敏感性结果被清空', () => {
    const studio = makeStudio();
    studio.analyze();
    studio.generateSensitivity('money', 'even', 'exact');
    expect(studio.sensitivity.value!.report.evaluationCount).toBe(1001);

    studio.load({
      draft: JSON.parse(JSON.stringify({
        ...studio.draft,
        id: 'other-case',
        title: '另一个决策',
      })),
    });
    expect(studio.sensitivity.value).toBeUndefined();
    expect(studio.probe.value).toBeUndefined();
  });

  it('试探越界自动夹到 [0,1000]', () => {
    const studio = makeStudio();
    studio.analyze();
    studio.previewProbe('money', 'even', 5000);
    expect(studio.probe.value!.index).toBe(1000);
    studio.previewProbe('money', 'even', -9);
    expect(studio.probe.value!.index).toBe(0);
  });
});
