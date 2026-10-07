import { describe, expect, it } from 'vitest';
import { createSampleDraft } from './sample-data';
import {
  analyzeAt,
  quantizeBase,
  reweight,
  runSensitivity,
  tenthsToPercents,
  TENTHS_TOTAL,
  type AdjustmentMode,
} from './sensitivity-service';
import type { DecisionDraft, DecisionOption, ValueKey, ValueWeights } from './models';
import { VALUE_KEYS } from './models';

const option = (
  id: string,
  name: string,
  impacts: DecisionOption['impacts'],
  reversibility = 70,
): DecisionOption => ({ id, name, description: '', impacts, reversibility });

const draft = (weights: ValueWeights, options: DecisionOption[]): DecisionDraft => ({
  id: 'test-case',
  title: '测试决策',
  background: '',
  weights,
  options,
  updatedAt: '2026-10-07T00:00:00.000Z',
});

const equalWeights: ValueWeights = { stability: 25, growth: 25, freedom: 25, money: 25 };
const sumTenths = (t: Record<ValueKey, number>) => VALUE_KEYS.reduce((n, k) => n + t[k], 0);

/* ---------------- 基准量化 ---------------- */

describe('quantizeBase', () => {
  it('归一化并量化为总和 1000 的 tenths', () => {
    const t = quantizeBase({ stability: 30, growth: 35, freedom: 20, money: 15 });
    expect(sumTenths(t)).toBe(1000);
    expect(t).toEqual({ stability: 300, growth: 350, freedom: 200, money: 150 });
  });

  it('未归一化的原始滑块值按引擎口径归一化后量化', () => {
    const t = quantizeBase({ stability: 3, growth: 0, freedom: 0, money: 1 });
    expect(sumTenths(t)).toBe(1000);
    expect(t.stability).toBe(750);
    expect(t.money).toBe(250);
  });

  it('带小数归一化时用最大余数法保证总和', () => {
    const t = quantizeBase({ stability: 1, growth: 1, freedom: 1, money: 0 });
    expect(sumTenths(t)).toBe(1000);
    expect(t.stability + t.growth + t.freedom).toBe(1000);
  });
});

/* ---------------- 再分配 ---------------- */

describe('reweight · 等比缩放', () => {
  const base = quantizeBase(equalWeights);

  it('其余三维度保持相对比例、总和恒为 1000', () => {
    for (const index of [0, 1, 250, 333, 700, 1000]) {
      const w = reweight(base, 'growth', index, 'proportional');
      expect(w.growth).toBe(index);
      expect(sumTenths(w)).toBe(TENTHS_TOTAL);
      // 其余三维度基准相等，最大余数法下彼此至多相差 1 个 tenth
      const others = [w.stability, w.freedom, w.money];
      expect(Math.max(...others) - Math.min(...others)).toBeLessThanOrEqual(1);
      expect(w.stability + w.freedom + w.money).toBe(1000 - index);
    }
  });

  it('按非等基准保持相对比例（2:1:1）', () => {
    const b = quantizeBase({ stability: 40, growth: 0, freedom: 30, money: 30 });
    const w = reweight(b, 'growth', 500, 'proportional');
    expect(w.growth).toBe(500);
    expect(w.stability + w.freedom + w.money).toBe(500);
    expect(w.freedom).toBe(w.money);
    // stability : freedom = 4 : 3
    expect(Math.abs(w.stability / 4 - w.freedom / 3)).toBeLessThanOrEqual(1);
  });

  it('其余维度基准全为 0 时回退均摊（在 runSensitivity 层面体现 mode）', () => {
    const b: Record<ValueKey, number> = { stability: 1000, growth: 0, freedom: 0, money: 0 };
    // 直接调用 proportional 数学式会除以 0；服务层 runSensitivity 负责回退
    const d = draft({ stability: 100, growth: 0, freedom: 0, money: 0 }, [
      option('a', '甲', { stability: 1, growth: 0, freedom: 0, money: 0 }),
      option('b', '乙', { stability: -1, growth: 0, freedom: 0, money: 0 }),
    ]);
    const report = runSensitivity(d, 'stability', 'proportional', 'exact', 1);
    expect(report.mode).toBe('even');
    expect(report.notices.some((n) => n.includes('自动改为平均分摊'))).toBe(true);
  });
});

describe('reweight · 平均分摊', () => {
  it('增量由其余维度均摊，触 0 后由剩余维度继续承担', () => {
    const b = quantizeBase({ stability: 20, growth: 10, freedom: 10, money: 60 });
    const w = reweight(b, 'money', 300, 'even');
    expect(w.money).toBe(300);
    expect(sumTenths(w)).toBe(1000);
    // money 从 600 降到 300，释放 300，其余三维各 +100
    expect(w.stability).toBe(300);
    expect(w.growth).toBe(200);
    expect(w.freedom).toBe(200);
  });

  it('排水时较小维度率先归零，剩余维度继续承担', () => {
    const b = quantizeBase({ stability: 5, growth: 5, freedom: 50, money: 40 });
    const w = reweight(b, 'freedom', 900, 'even');
    expect(w.freedom).toBe(900);
    expect(sumTenths(w)).toBe(1000);
    expect(w.stability).toBe(0);
    expect(w.growth).toBe(0);
    // 100 个 tenths 全部由 money 让出
    expect(w.money).toBe(100);
  });

  it('端点：x=0 与 x=1000', () => {
    const b = quantizeBase(equalWeights);
    const zero = reweight(b, 'money', 0, 'even');
    expect(zero.money).toBe(0);
    expect(sumTenths(zero)).toBe(1000);
    const full = reweight(b, 'money', 1000, 'even');
    expect(full).toEqual({ stability: 0, growth: 0, freedom: 0, money: 1000 });
  });
});

/* ---------------- 引擎一致性 ---------------- */

describe('analyzeAt 与现有规则一致', () => {
  it('在基准权重位置的复算与直接分析相同', () => {
    const d = draft({ stability: 30, growth: 35, freedom: 20, money: 15 }, [
      option('stay', '留下', { stability: 4, growth: -1, freedom: 0, money: 2 }, 75),
      option('leave', '离开', { stability: -2, growth: 5, freedom: 2, money: 3 }, 55),
    ]);
    const base = quantizeBase(d.weights);
    const probe = analyzeAt(d, base, 'growth', base.growth, 'proportional');
    const exactPercent = base.growth;
    expect(probe.index).toBe(exactPercent);
    // 基准点的再分配应还原基准权重
    expect(probe.weights).toEqual(tenthsToPercents(base));
  });

  it('试探不修改方案权重', () => {
    const d = createSampleDraft();
    const snapshot = { ...d.weights };
    const base = quantizeBase(d.weights);
    analyzeAt(d, base, 'money', 900, 'proportional');
    expect(d.weights).toEqual(snapshot);
  });
});

/* ---------------- 扫描策略 ---------------- */

// 简单确定性随机数（mulberry32），用于构造与 fuzz
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomDraft(rand: () => number): DecisionDraft {
  const n = 2 + Math.floor(rand() * 3);
  const options: DecisionOption[] = [];
  for (let i = 0; i < n; i += 1) {
    options.push(
      option(
        `o${i}`,
        `选项${i}`,
        {
          stability: Math.round((rand() * 10 - 5) * 10) / 10,
          growth: Math.round((rand() * 10 - 5) * 10) / 10,
          freedom: Math.round((rand() * 10 - 5) * 10) / 10,
          money: Math.round((rand() * 10 - 5) * 10) / 10,
        },
        30 + Math.floor(rand() * 65),
      ),
    );
  }
  const weights: ValueWeights = {
    stability: 1 + Math.floor(rand() * 97),
    growth: 1 + Math.floor(rand() * 97),
    freedom: 1 + Math.floor(rand() * 97),
    money: 1 + Math.floor(rand() * 97),
  };
  return draft(weights, options);
}

/** 把报告展开为每个 tenth 索引的签名（未验证段返回 'unknown'）。 */
function signatureTrace(report: ReturnType<typeof runSensitivity>): string[] {
  const trace = new Array<string>(1001).fill('unknown');
  for (const s of report.segments) {
    const sig = s.tie ? `tie:${s.winnerIds.join('|')}` : s.verified ? `win:${s.winnerIds[0]}` : 'unknown';
    for (let i = s.startIndex; i <= s.endIndex; i += 1) trace[i] = s.verified ? sig : 'unknown';
  }
  return trace;
}

describe('自适应细化 vs 0.1% 精扫：fuzz 等价', () => {
  it('在数百个随机方案上逐点签名完全一致', () => {
    let checked = 0;    for (const seed of [20261007, 11, 4242, 9001]) {
      const rand = mulberry32(seed);
      for (let trial = 0; trial < 150; trial += 1) {
        const d = randomDraft(rand);
        const dimension = VALUE_KEYS[Math.floor(rand() * 4)];
        const mode: AdjustmentMode = rand() > 0.5 ? 'proportional' : 'even';
        const exact = signatureTrace(runSensitivity(d, dimension, mode, 'exact', 1));
        const adaptive = signatureTrace(runSensitivity(d, dimension, mode, 'adaptive', 1));
        for (let i = 0; i <= 1000; i += 1) {
          expect(adaptive[i], `seed=${seed} trial=${trial} dim=${dimension} mode=${mode} i=${i}`).toBe(exact[i]);
        }
        checked += 1;
      }
    }
    expect(checked).toBe(600);
  }, 30000);

  it('智能细化的复算量不超过精扫，且全程恒定的方案只需 21 个粗点', () => {
    const rand = mulberry32(42);
    for (let trial = 0; trial < 20; trial += 1) {
      const d = randomDraft(rand);
      const dimension = VALUE_KEYS[Math.floor(rand() * 4)];
      const adaptive = runSensitivity(d, dimension, 'proportional', 'adaptive', 1);
      const exact = runSensitivity(d, dimension, 'proportional', 'exact', 1);
      expect(adaptive.evaluationCount).toBeLessThanOrEqual(exact.evaluationCount);
    }
    const impacts = { stability: 1, growth: 1, freedom: 1, money: 1 };
    const flat = draft(equalWeights, [option('a', '甲', { ...impacts }), option('b', '乙', { ...impacts })]);
    const report = runSensitivity(flat, 'growth', 'proportional', 'adaptive', 1);
    expect(report.evaluationCount).toBe(21);
  });
});

describe('固定粗扫会遗漏窄区间', () => {
  it('能找到至少一个“粗扫看不到并列、精扫能看到窄并列带”的随机方案', () => {
    const rand = mulberry32(7);
    let found = false;
    for (let trial = 0; trial < 6000 && !found; trial += 1) {
      const d = randomDraft(rand);
      const dimension = VALUE_KEYS[Math.floor(rand() * 4)];
      const mode: AdjustmentMode = 'proportional';
      const exactReport = runSensitivity(d, dimension, mode, 'exact', 1);
      const coarseReport = runSensitivity(d, dimension, mode, 'coarse', 1);
      const exactTrace = signatureTrace(exactReport);
      const coarseTrace = signatureTrace(coarseReport);
      // 精扫出现的某个并列签名，在粗扫的已验证点上从未出现，且并列带较窄（<50 tenths）
      const tieSigs = new Set(exactTrace.filter((s) => s.startsWith('tie:')));
      for (const sig of tieSigs) {
        const runLengths: number[] = [];
        let run = 0;
        for (const s of exactTrace) {
          if (s === sig) run += 1;
          else if (run > 0) {
            runLengths.push(run);
            run = 0;
          }
        }
        if (run > 0) runLengths.push(run);
        const narrow = runLengths.some((len) => len < 50);
        const coarseHas = coarseTrace.some((s) => s === sig);
        if (narrow && !coarseHas) {
          found = true;
          // 同一方案上自适应必须发现它
          const adaptiveReport = runSensitivity(d, dimension, mode, 'adaptive', 1);
          const adaptiveTrace = signatureTrace(adaptiveReport);
          expect(adaptiveTrace).toContain(sig);
          break;
        }
      }
    }
    expect(found, '随机空间中应存在窄并列带案例').toBe(true);
  });
});

/* ---------------- 区间、转折与文案 ---------------- */

describe('零权重 / 极端偏好 / 多转折 / 并列区间', () => {
  it('单维度独裁时 x=100 端点给出可解释结果', () => {
    const d = draft(equalWeights, [
      option('a', '甲', { stability: 5, growth: 0, freedom: 0, money: 0 }),
      option('b', '乙', { stability: -5, growth: 0, freedom: 0, money: 0 }),
    ]);
    const report = runSensitivity(d, 'stability', 'proportional', 'exact', 1);
    const end = report.segments.find((s) => s.verified && s.endIndex === 1000)!;
    expect(end.tie).toBe(false);
    expect(end.winnerIds).toEqual(['a']);
    expect(report.notices.some((n) => n.includes('只看稳定'))).toBe(true);
  });

  it('零权重端点单独成段且文案可解释', () => {
    const d = createSampleDraft();
    const report = runSensitivity(d, 'money', 'proportional', 'exact', 1);
    const start = report.segments.find((s) => s.verified && s.startIndex === 0)!;
    expect(start).toBeDefined();
    expect(report.notices.some((n) => n.includes('=0%'))).toBe(true);
  });

  it('转折点的索引与前后签名相邻相接', () => {
    const rand = mulberry32(99);
    let foundMulti = false;
    for (let trial = 0; trial < 400 && !foundMulti; trial += 1) {
      const d = randomDraft(rand);
      const dimension = VALUE_KEYS[Math.floor(rand() * 4)];
      const report = runSensitivity(d, dimension, 'even', 'exact', 1);
      if (report.turningPoints.length >= 2) {
        foundMulti = true;
        // 每个转折点前后段必须相接，且转折值属于“之后”段
        for (const tp of report.turningPoints) {
          const before = report.segments.find((s) => s.endIndex === tp.index - 1);
          const after = report.segments.find((s) => s.startIndex === tp.index);
          expect(before).toBeDefined();
          expect(after).toBeDefined();
          const beforeSig = before!.tie ? `tie:${before!.winnerIds.join('|')}` : `win:${before!.winnerIds[0]}`;
          const afterSig = after!.tie ? `tie:${after!.winnerIds.join('|')}` : `win:${after!.winnerIds[0]}`;
          expect(beforeSig).not.toBe(afterSig);
        }
      }
    }
    expect(foundMulti, '随机空间中应存在多转折方案').toBe(true);
  });

  it('全程无变化时只有一个覆盖全域的验证段并给出说明', () => {
    // 两个选项四维影响完全相同：任何权重下都并列
    const impacts = { stability: 2, growth: 1, freedom: 0, money: -1 };
    const d = draft(equalWeights, [option('a', '甲', { ...impacts }), option('b', '乙', { ...impacts })]);
    const report = runSensitivity(d, 'growth', 'proportional', 'exact', 1);
    const verified = report.segments.filter((s) => s.verified);
    expect(verified.length).toBe(1);
    expect(verified[0].startIndex).toBe(0);
    expect(verified[0].endIndex).toBe(1000);
    expect(verified[0].tie).toBe(true);
    expect(report.turningPoints.length).toBe(0);
    expect(report.notices.some((n) => n.includes('全程'))).toBe(true);
  });
});

describe('粗扫模式的未验证间隔', () => {
  it('粗点之间标记为 unverified 且不分配胜者', () => {
    const d = createSampleDraft();
    const report = runSensitivity(d, 'growth', 'proportional', 'coarse', 1);
    const gaps = report.segments.filter((s) => !s.verified);
    expect(gaps.length).toBeGreaterThan(0);
    expect(gaps.every((g) => g.winnerIds.length === 0)).toBe(true);
    // 粗点段仍真实复算
    expect(report.segments.filter((s) => s.verified).length).toBe(21);
    // 未验证间隔两侧不产生声称的转折点
    expect(report.notices.some((n) => n.includes('未经验证'))).toBe(true);
  });
});
