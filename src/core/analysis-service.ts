import { normalizeWeights } from './weight-service';
import {
  VALUE_KEYS,
  VALUE_LABELS,
  type DecisionAnalysis,
  type DecisionDraft,
  type DecisionOption,
  type Horizon,
  type OptionAnalysis,
  type RegretPoint,
  type RehearsalCard,
  type ValueKey,
  type ValueWeights,
} from './models';

const HORIZONS: Horizon[] = [1, 5, 10];
const TOTAL_MIX: Record<Horizon, number> = { 1: 0.3, 5: 0.4, 10: 0.3 };

const timeFactor: Record<Horizon, Record<ValueKey, number>> = {
  1: { stability: 1.2, growth: 0.75, freedom: 0.8, money: 1.15 },
  5: { stability: 1, growth: 1, freedom: 1, money: 1 },
  10: { stability: 0.8, growth: 1.25, freedom: 1.2, money: 0.85 },
};

/** 不可逆成本：与权重无关，只取决于可逆性与时间跨度。 */
function irreversibleCost(option: DecisionOption, horizon: Horizon): number {
  return (100 - option.reversibility) * 0.08 * (horizon / 10);
}

/**
 * 未取整、未截断的单时间点后悔分（线性部分 + 不可逆成本）。
 * 敏感性分析用它判断“哪里可能发生名次/并列变化”，不直接用于展示名次。
 */
export function rawHorizonScore(option: DecisionOption, weights: ValueWeights, horizon: Horizon): number {
  let value = 0;
  for (const key of VALUE_KEYS) {
    const negative = (5 - option.impacts[key]) / 10;
    value += negative * weights[key] * timeFactor[horizon][key];
  }
  return value + irreversibleCost(option, horizon);
}

/**
 * 截断到 [0,100] 但不四舍五入的单时间点分；分段线性，折点只在截断边界。
 * 敏感性分析用它定位候选转折（与引擎同构，不会把截断区内外连成一条直线）。
 */
export function clampedHorizonScore(option: DecisionOption, weights: ValueWeights, horizon: Horizon): number {
  return Math.max(0, Math.min(100, rawHorizonScore(option, weights, horizon)));
}

/**
 * 总分的未取整形式：仍按引擎口径 30%/40%/40%/30% 混合三个时间点，
 * 仅省去最外层四舍五入（各时间点保留引擎的截断规则）。
 */
export function rawTotalScore(option: DecisionOption, weights: ValueWeights): number {
  return HORIZONS.reduce((sum, h) => sum + TOTAL_MIX[h] * clampedHorizonScore(option, weights, h), 0);
}

function horizonPoint(option: DecisionOption, weights: ValueWeights, horizon: Horizon): RegretPoint {
  const breakdown = {} as RegretPoint['breakdown'];
  let value = 0;
  for (const key of VALUE_KEYS) {
    const negative = (5 - option.impacts[key]) / 10;
    const part = negative * weights[key] * timeFactor[horizon][key];
    breakdown[key] = Math.round(part * 10) / 10;
    value += part;
  }
  const score = Math.max(0, Math.min(100, Math.round(value + irreversibleCost(option, horizon))));
  return { horizon, score, breakdown };
}

function rehearsalCard(option: DecisionOption, point: RegretPoint, weights: ValueWeights): RehearsalCard {
  const key = VALUE_KEYS.slice().sort(
    (a, b) => weights[b] * (5 - option.impacts[b]) - weights[a] * (5 - option.impacts[a]),
  )[0];
  const label = VALUE_LABELS[key];
  return {
    horizon: point.horizon,
    regret: `${point.horizon} 年后，你可能遗憾「${option.name}」没有更好照顾${label}。`,
    trigger: `当${label}需求持续得不到满足，后悔感可能升高。`,
    reversibility: option.reversibility >= 60 ? '仍有较大调整空间' : '改变成本可能随时间增加',
    action: `现在就为${label}设一个可检查的阶段目标。`,
  };
}

export function safetyNoticesFor(text: string): string[] {
  const notices: string[] = [];
  if (/医疗|诊断|治疗|medical/i.test(text)) notices.push('涉及医疗，请同时咨询合格医疗专业人士。');
  if (/法律|诉讼|合同|legal/i.test(text)) notices.push('涉及法律，请同时咨询合格法律专业人士。');
  if (/投资|股票|理财|investment/i.test(text)) notices.push('涉及投资，请评估承受能力并咨询持牌专业人士。');
  return notices;
}

/** 用一组临时权重对同一方案执行完整规则引擎；不修改入参 draft。 */
export function analyzeWithWeights(draft: DecisionDraft, weights: ValueWeights): DecisionAnalysis {
  return analyzeDecision({ ...draft, weights });
}

export function analyzeDecision(draft: DecisionDraft): DecisionAnalysis {
  const weights = normalizeWeights(draft.weights);
  const options: OptionAnalysis[] = draft.options
    .map((option) => {
      const points = HORIZONS.map((h) => horizonPoint(option, weights, h));
      return {
        option,
        points,
        cards: points.map((p) => rehearsalCard(option, p, weights)),
        total: Math.round(points[0].score * 0.3 + points[1].score * 0.4 + points[2].score * 0.3),
      };
    })
    .sort((a, b) => a.total - b.total);
  const close = options[1] && options[1].total - options[0].total < 5;
  return {
    options,
    recommendation: close
      ? `「${options[0].option.name}」与「${options[1].option.name}」非常接近，建议补充信息后再决定。`
      : `目前看，「${options[0].option.name}」是更不容易后悔的方向。`,
    winnerId: close ? undefined : options[0].option.id,
    notices: safetyNoticesFor(`${draft.title} ${draft.background}`),
  };
}
