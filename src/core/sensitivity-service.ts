import { analyzeWithWeights, clampedHorizonScore, rawHorizonScore } from './analysis-service';
import { normalizeWeights } from './weight-service';
import { VALUE_KEYS, VALUE_LABELS, type DecisionDraft, type ValueKey, type ValueWeights } from './models';

/** 权重以 0.1% 为最小单位：1000 tenths = 100%。滑块的每个可达权重都是 tenths 整数。 */
export const TENTHS_TOTAL = 1000;
const GRID_END = TENTHS_TOTAL;
const COARSE_STEP = 50; // 粗扫步长 5.0%

export type AdjustmentMode = 'proportional' | 'even';
export type ScanStrategy = 'coarse' | 'adaptive' | 'exact';

export interface SensitivitySegment {
  /** 闭区间端点，单位 0.1%（1000 = 100%）。相邻段共享端点时，转折值属于右侧段。 */
  startIndex: number;
  endIndex: number;
  /** 唯一胜者 1 个；并列 2 个（引擎排序后的前两名）。 */
  winnerIds: string[];
  tie: boolean;
  /** 段内每个权重点是否都由规则引擎在 0.1% 粒度真实复算覆盖。false 表示仅粗采样+证明。 */
  verified: boolean;
}

export interface TurningPoint {
  /** 转折发生的最小权重（0.1% 单位）：恰为该值时已经是新建议。 */
  index: number;
  percent: number;
  beforeIds: string[];
  beforeTie: boolean;
  afterIds: string[];
  afterTie: boolean;
}

export interface SensitivityReport {
  dimension: ValueKey;
  mode: AdjustmentMode;
  strategy: ScanStrategy;
  /** 量化到 0.1% 的基准权重（tenths），试探即相对它进行。 */
  baseTenths: Record<ValueKey, number>;
  basePercents: ValueWeights;
  segments: SensitivitySegment[];
  turningPoints: TurningPoint[];
  evaluationCount: number;
  notices: string[];
  version: number;
}

type Tenths = Record<ValueKey, number>;

/* ------------------------------------------------------------------ */
/* 基准权重量化                                                         */
/* ------------------------------------------------------------------ */

/**
 * 把原始（滑块整数、可能未归一化）权重量化为总和 1000 的 tenths：
 * 先按引擎同款归一化得到份额，再用最大余数法分配整数，保证总和恒为 1000。
 */
export function quantizeBase(rawWeights: ValueWeights): Tenths {
  const percents = normalizeWeights(rawWeights); // 0..100，和为 100（允许 0.1% 舍入误差）
  const scaled = VALUE_KEYS.map((k) => ({ k, exact: percents[k] * 10 }));
  const floors = scaled.map((s) => Math.floor(s.exact));
  let remainder = TENTHS_TOTAL - floors.reduce((n, f) => n + f, 0);
  const order = scaled
    .map((s, i) => ({ i, frac: s.exact - Math.floor(s.exact) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (remainder <= 0) break;
    floors[i] += 1;
    remainder -= 1;
  }
  return Object.fromEntries(scaled.map((s, i) => [s.k, floors[i]])) as Tenths;
}

/* ------------------------------------------------------------------ */
/* 再分配：选中维度占 x（tenths），其余维度按所选方式调整                 */
/* ------------------------------------------------------------------ */

function largestRemainder(exact: { k: ValueKey; exact: number }[], total: number): Tenths {
  const floors = exact.map((e) => Math.max(0, Math.floor(e.exact)));
  const used = floors.reduce((n, f) => n + f, 0);
  let remainder = total - used;
  const order = exact
    .map((e, i) => ({ i, frac: e.exact - Math.floor(e.exact) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (remainder <= 0) break;
    floors[i] += 1;
    remainder -= 1;
  }
  return Object.fromEntries(exact.map((e, i) => [e.k, floors[i]])) as Tenths;
}

/**
 * 注水/排水式均摊：使 keys 的 tenths 合计恰为 target。
 * 每个键从各自 base 出发移动相同的 δ；触到 0（排水）或 1000（注水）的键退出，
 * 其余键继续均分 δ；最终用最大余数法把浮点结果落为整数（总和 target）。
 */
function redistribute(base: Tenths, keys: ValueKey[], target: number): Tenths {
  const result = { ...base };
  if (keys.length === 0) return result;
  let active = keys.slice();
  const floats = new Map<ValueKey, number>();
  for (let guard = 0; guard <= keys.length; guard += 1) {
    const held = keys.filter((k) => !active.includes(k)).reduce((n, k) => n + floats.get(k)!, 0);
    const activeBase = active.reduce((n, k) => n + base[k], 0);
    const delta = (target - held - activeBase) / active.length;
    let crossed = false;
    const nextActive: ValueKey[] = [];
    for (const k of active) {
      const v = base[k] + delta;
      if (v <= 0) {
        floats.set(k, 0);
        crossed = true;
      } else if (v >= TENTHS_TOTAL) {
        floats.set(k, TENTHS_TOTAL);
        crossed = true;
      } else {
        floats.set(k, v);
        nextActive.push(k);
      }
    }
    active = nextActive;
    if (!crossed || active.length === 0) break;
  }
  const exact = keys.map((k) => ({ k, exact: floats.get(k) ?? 0 }));
  const quantized = largestRemainder(exact, Math.max(0, Math.min(TENTHS_TOTAL, target)));
  for (const k of keys) result[k] = quantized[k];
  return result;
}

/**
 * 返回选中维度权重为 index/10（百分比）时的完整权重（tenths，总和 1000）。
 * proportional：其余维度保持相对比例；B=0 时回退均摊。
 * even：增量/减量由其余维度均摊，触 0 后由剩余维度继续承担。
 */
export function reweight(base: Tenths, dimension: ValueKey, index: number, mode: AdjustmentMode): Tenths {
  const others = VALUE_KEYS.filter((k) => k !== dimension);
  const baseOthers = others.reduce((n, k) => n + base[k], 0);
  const targetOthers = TENTHS_TOTAL - index;

  if (mode === 'proportional' && baseOthers > 0) {
    const exact = others.map((k) => ({ k, exact: (targetOthers * base[k]) / baseOthers }));
    const assigned = largestRemainder(exact, targetOthers);
    return { ...assigned, [dimension]: index } as Tenths;
  }

  const result = { ...base, [dimension]: index } as Tenths;
  const redistributed = redistribute(result, others, targetOthers);
  redistributed[dimension] = index;
  return redistributed;
}

export function tenthsToPercents(tenths: Tenths): ValueWeights {
  return Object.fromEntries(VALUE_KEYS.map((k) => [k, tenths[k] / 10])) as ValueWeights;
}

/* ------------------------------------------------------------------ */
/* 规则引擎复算（不修改方案）                                            */
/* ------------------------------------------------------------------ */

interface Verdict {
  signature: string;
  orderedIds: string[];
  winnerIds: string[];
  tie: boolean;
  totals: Map<string, number>;
}

function signatureOf(analysis: ReturnType<typeof analyzeWithWeights>): Verdict {
  const orderedIds = analysis.options.map((o) => o.option.id);
  const totals = new Map<string, number>();
  for (const o of analysis.options) totals.set(o.option.id, o.total);
  const tie = analysis.winnerId === undefined;
  const winnerIds = tie ? orderedIds.slice(0, 2) : [orderedIds[0]];
  return {
    signature: tie ? `tie:${winnerIds[0]}|${winnerIds[1]}` : `win:${winnerIds[0]}`,
    orderedIds,
    winnerIds,
    tie,
    totals,
  };
}

export interface ProbeResult {
  index: number;
  weights: ValueWeights;
  analysis: ReturnType<typeof analyzeWithWeights>;
}

/* ------------------------------------------------------------------ */
/* 扫描                                                                 */
/* ------------------------------------------------------------------ */

interface ScanContext {
  draft: DecisionDraft;
  base: Tenths;
  dimension: ValueKey;
  mode: AdjustmentMode;
  cache: Map<number, Verdict>;
  rawCache: Map<number, Map<string, number>>;
  evaluations: number;
}

function evaluate(ctx: ScanContext, index: number): Verdict {
  const hit = ctx.cache.get(index);
  if (hit) return hit;
  const weights = tenthsToPercents(reweight(ctx.base, ctx.dimension, index, ctx.mode));
  const analysis = analyzeWithWeights(ctx.draft, weights);
  ctx.evaluations += 1;
  const verdict = signatureOf(analysis);
  ctx.cache.set(index, verdict);
  return verdict;
}

function rawTotals(ctx: ScanContext, index: number): Map<string, number> {
  const hit = ctx.rawCache.get(index);
  if (hit) return hit;
  const weights = tenthsToPercents(reweight(ctx.base, ctx.dimension, index, ctx.mode));
  const map = new Map<string, number>();
  // 用截断后、未取整的分：与引擎同构，分段线性的折点精确位于 0/100 截断边界
  for (const option of ctx.draft.options) {
    const total = ([1, 5, 10] as const).reduce(
      (sum, h) => sum + (h === 1 ? 0.3 : h === 5 ? 0.4 : 0.3) * clampedHorizonScore(option, weights, h),
      0,
    );
    map.set(option.id, total);
  }
  ctx.rawCache.set(index, map);
  return map;
}

/** 未截断原始分是否在该粗格内跨越 0 或 100 截断边界（两侧各留 2.5 分保护带）。 */
function hasClampKink(ctx: ScanContext, left: number, right: number): boolean {
  const wl = tenthsToPercents(reweight(ctx.base, ctx.dimension, left, ctx.mode));
  const wr = tenthsToPercents(reweight(ctx.base, ctx.dimension, right, ctx.mode));
  const crosses = (a: number, b: number, edge: number) => {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    // 未截断分真正从 edge 一侧跨到另一侧（两端不都在同侧），两侧留 2.5 保护带
    return lo <= edge + 2.5 && hi >= edge - 2.5;
  };
  for (const option of ctx.draft.options) {
    for (const horizon of [1, 5, 10] as const) {
      const a = rawHorizonScore(option, wl, horizon);
      const b = rawHorizonScore(option, wr, horizon);
      if (crosses(a, b, 0) || crosses(a, b, 100)) return true;
    }
  }
  return false;
}

/**
 * 在一个粗格 [left,right] 内找出所有“可能改变建议”的 tenths 子区间。
 * 事件只有两类：选项对总分差穿越 0（易主）或穿越 ±5（并列进出）。
 * 用端点未取整分差做线性求解；保护带 ±2 分覆盖两层四舍五入最坏误差。
 */
function suspectRangesInCell(ctx: ScanContext, left: number, right: number): Array<[number, number]> {
  // 含截断 kink 的格子整体不满足分段线性，直接整格细扫（不在线性结构上做任何推断）
  if (hasClampKink(ctx, left, right)) return [[left, right]];
  const leftRaw = rawTotals(ctx, left);
  const rightRaw = rawTotals(ctx, right);
  const ids = ctx.draft.options.map((o) => o.id);
  const ranges: Array<[number, number]> = [];
  const width = right - left;
  const addAroundRoot = (rootIn: number, slope: number) => {
    // 穿越点两侧各 ±2.5 个分差单位换算为 tenths 宽度；
    // 覆盖外层取整（0.5）与三个 horizon 取整（最坏 2）的合成误差；
    // 斜率为 0 时整格存疑
    if (slope === 0) {
      ranges.push([left, right]);
      return;
    }
    const root = Math.max(left, Math.min(right, rootIn));
    const guard = Math.ceil(2.5 / Math.abs(slope));
    const center = Math.round(root);
    ranges.push([Math.max(left, center - guard), Math.min(right, center + guard)]);
  };
  /**
   * 未穿越阈值但整段贴近：只细扫“D(x) 距阈值 ≤2.5”的子区间（分段线性，
   * 该区间即取整后可能改变判定的全部位置），不扩大到整个粗格。
   */
  const addNearThreshold = (da: number, db: number, threshold: number) => {
    const lo = Math.min(da, db);
    const hi = Math.max(da, db);
    if (hi < threshold - 2.5 || lo > threshold + 2.5) return;
    if (db === da) {
      ranges.push([left, right]); // 水平贴着阈值
      return;
    }
    const xAt = (d: number) => left + ((d - da) / (db - da)) * width;
    // 阈值带 [threshold-2.5, threshold+2.5] 与本格 [left,right] 的交集
    const l = Math.max(left, Math.ceil(xAt(threshold - 2.5)));
    const r = Math.min(right, Math.floor(xAt(threshold + 2.5)));
    if (r >= l) ranges.push([l, r]);
    else {
      // 带的理论端点都落在格外，但其在格内的投影仍可能贴近：退化为整格细扫
      ranges.push([left, right]);
    }
  };
  for (let a = 0; a < ids.length; a += 1) {
    for (let b = a + 1; b < ids.length; b += 1) {
      const da = leftRaw.get(ids[a])! - leftRaw.get(ids[b])!;
      const db = rightRaw.get(ids[a])! - rightRaw.get(ids[b])!;
      const slope = (db - da) / width; // 每 tenth 的分差变化
      for (const threshold of [0, 5, -5]) {
        // 0 = 选项对易主；±5 = 该对差距进入/离开“<5 即并列”（正负两侧都可能改变 top-2 并列状态）
        if ((da - threshold) * (db - threshold) <= 0) {
          // 理论穿越点（仅用于定位，不用于命名胜者）
          if (da === db) {
            // D 在本格恒定。若恰为 0：两个选项全程相等，签名不可能在格内因这一对改变；
            // 若恒为 ±5：并列判定可能被外层取整左右，整格细扫
            if (threshold !== 0) ranges.push([left, right]);
          } else {
            addAroundRoot(left + (threshold - da) / slope, slope);
          }
        } else {
          // 未穿越但贴近阈值：双重取整后仍可能进入/离开并列或易主
          addNearThreshold(da, db, threshold);
        }
      }
    }
  }
  return mergeRanges(ranges);
}

function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  if (ranges.length === 0) return [];
  const sorted = ranges.slice().sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const merged: Array<[number, number]> = [sorted[0]];
  for (const [l, r] of sorted.slice(1)) {
    const last = merged[merged.length - 1];
    if (l <= last[1] + 1) last[1] = Math.max(last[1], r);
    else merged.push([l, r]);
  }
  return merged;
}

interface BuiltSegment {
  startIndex: number;
  endIndex: number;
  signature: string;
  winnerIds: string[];
  tie: boolean;
  verified: boolean;
}

function verdictToSegmentPart(v: Verdict) {
  return { signature: v.signature, winnerIds: v.winnerIds, tie: v.tie };
}

function buildSegmentsFromGrid(
  verdicts: Map<number, Verdict>,
  verified: Set<number>,
): BuiltSegment[] {
  const indices = Array.from(verdicts.keys()).sort((a, b) => a - b);
  const segments: BuiltSegment[] = [];
  let current: BuiltSegment | null = null;
  for (const index of indices) {
    const v = verdicts.get(index)!;
    const isVerified = verified.has(index);
    if (
      current &&
      index === current.endIndex + 1 &&
      current.signature === v.signature &&
      current.verified === isVerified
    ) {
      current.endIndex = index;
    } else {
      if (current) segments.push(current);
      current = { startIndex: index, endIndex: index, ...verdictToSegmentPart(v), verified: isVerified };
    }
  }
  if (current) segments.push(current);
  return segments;
}

function runExact(ctx: ScanContext): BuiltSegment[] {
  const verdicts = new Map<number, Verdict>();
  const verified = new Set<number>();
  for (let i = 0; i <= GRID_END; i += 1) {
    verdicts.set(i, evaluate(ctx, i));
    verified.add(i);
  }
  return buildSegmentsFromGrid(verdicts, verified);
}

function runAdaptive(ctx: ScanContext): BuiltSegment[] {
  const verdicts = new Map<number, Verdict>();
  const verified = new Set<number>();
  const coarsePoints: number[] = [];
  for (let i = 0; i <= GRID_END; i += COARSE_STEP) coarsePoints.push(i);
  for (const i of coarsePoints) {
    verdicts.set(i, evaluate(ctx, i));
    verified.add(i);
  }
  for (let c = 0; c < coarsePoints.length - 1; c += 1) {
    const left = coarsePoints[c];
    const right = coarsePoints[c + 1];
    const ranges = suspectRangesInCell(ctx, left, right);
    const finePoints = new Set<number>();
    for (const [l, r] of ranges) {
      for (let i = l; i <= r; i += 1) finePoints.add(i);
    }
    if (finePoints.size === 0) {
      // 无候选事件：分段线性下签名恒定，粗点签名覆盖整格（含右端已由下一粗点评估）
      const v = verdicts.get(left)!;
      for (let i = left + 1; i < right; i += 1) {
        verdicts.set(i, v);
        verified.add(i); // 由“无穿越”证明覆盖
      }
    } else {
      // 细扫保护带；其余子区间无候选事件，取一个代表点复算后沿用其签名
      const fillGap = (from: number, to: number, sampleAt: number) => {
        if (from > to) return;
        const sample = Math.max(from, Math.min(to, sampleAt));
        const v = verdicts.has(sample) ? verdicts.get(sample)! : evaluate(ctx, sample);
        for (let i = from; i <= to; i += 1) {
          verdicts.set(i, v);
          verified.add(i); // 由“该子区间内无任何候选穿越/kink”证明覆盖
        }
      };
      let cursor = left;
      for (const [l, r] of ranges) {
        fillGap(cursor + 1, l - 1, cursor);
        for (let i = l; i <= r; i += 1) {
          verdicts.set(i, evaluate(ctx, i));
          verified.add(i);
        }
        cursor = r;
      }
      fillGap(cursor + 1, right - 1, right);
    }
  }
  return buildSegmentsFromGrid(verdicts, verified);
}

function runCoarse(ctx: ScanContext): BuiltSegment[] {
  // 仅 5% 粗采样：粗点本身 verified，点间为未验证间隔，绝不猜测胜者。
  const segments: BuiltSegment[] = [];
  const points: number[] = [];
  for (let i = 0; i <= GRID_END; i += COARSE_STEP) points.push(i);
  for (let c = 0; c < points.length; c += 1) {
    const index = points[c];
    const v = evaluate(ctx, index);
    segments.push({ startIndex: index, endIndex: index, ...verdictToSegmentPart(v), verified: true });
    if (c < points.length - 1 && points[c + 1] > index + 1) {
      segments.push({ startIndex: index + 1, endIndex: points[c + 1] - 1, signature: '', winnerIds: [], tie: false, verified: false });
    }
  }
  return segments;
}

/* ------------------------------------------------------------------ */
/* 转折点、文案                                                          */
/* ------------------------------------------------------------------ */

function deriveTurningPoints(segments: BuiltSegment[]): TurningPoint[] {
  const real = segments.filter((s) => s.verified || s.winnerIds.length > 0);
  const points: TurningPoint[] = [];
  for (let i = 1; i < segments.length; i += 1) {
    const before = segments[i - 1];
    const after = segments[i];
    if (!before.verified || !after.verified) continue; // 未验证间隔两侧不声称转折
    if (before.signature === after.signature) continue;
    points.push({
      index: after.startIndex,
      percent: Math.round(after.startIndex) / 10,
      beforeIds: before.winnerIds,
      beforeTie: before.tie,
      afterIds: after.winnerIds,
      afterTie: after.tie,
    });
  }
  return points;
}

function idsToNames(draft: DecisionDraft, ids: string[]): string {
  return ids
    .map((id) => draft.options.find((o) => o.id === id)?.name ?? id)
    .join(' 与 ');
}

function buildNotices(
  draft: DecisionDraft,
  report: Omit<SensitivityReport, 'notices'>,
  fallbackEven: boolean,
): string[] {
  const notices: string[] = [];
  const label = VALUE_LABELS[report.dimension];
  if (report.strategy === 'coarse') {
    notices.push('当前为 5% 粗扫：灰色斜纹区间未经验证，其中可能存在更窄的并列带或多次易主；请改用“智能细化”或“精确扫描”。');
  } else if (report.strategy === 'adaptive') {
    notices.push(`智能细化：用未取整的分段线性公式定位所有可能的易主（分差过 0）与并列进出（分差过 ±5）位置，只在这些位置附近按 0.1% 复算，实际复算 ${report.evaluationCount} 个权重。`);
  } else {
    notices.push(`精确扫描：对滑块可达的全部 1001 个权重（0.1% 粒度）逐点复算，无遗漏，实际复算 ${report.evaluationCount} 个权重。`);
  }
  notices.push(
    `调整方式：${report.mode === 'proportional' ? '其余维度保持相对比例等比缩放' : '其余维度平均分摊'}；权重已按 0.1% 量化（最大余数法，合计恒为 100%），所有名次均由规则引擎逐点复算，未使用图形插值。`,
  );
  if (fallbackEven) {
    notices.push(`基准方案中除「${label}」外的维度权重均为 0，没有相对比例可保持，已自动改为平均分摊。`);
  }
  const first = report.segments.find((s) => s.verified && s.startIndex === 0);
  const last = report.segments.find((s) => s.verified && s.endIndex === GRID_END);
  if (first) {
    notices.push(
      first.tie
        ? `零权重端点（${label}=0%）：完全不考虑${label}时，${idsToNames(draft, first.winnerIds)}并列。`
        : `零权重端点（${label}=0%）：完全不考虑${label}时，建议为「${idsToNames(draft, first.winnerIds)}」。`,
    );
  }
  if (last) {
    notices.push(
      last.tie
        ? `极端偏好端点（${label}=100%）：只看${label}时，${idsToNames(draft, last.winnerIds)}并列。`
        : `极端偏好端点（${label}=100%）：只看${label}时，建议为「${idsToNames(draft, last.winnerIds)}」。`,
    );
  }
  const verifiedSegments = report.segments.filter((s) => s.verified);
  const signatures = new Set(verifiedSegments.map((s) => (s.tie ? `tie:${s.winnerIds.join('|')}` : `win:${s.winnerIds[0]}`)));
  if (signatures.size === 1 && report.strategy !== 'coarse') {
    const only = verifiedSegments[0];
    notices.push(
      only.tie
        ? `在 0–100% 全程，建议始终为「${idsToNames(draft, only.winnerIds)}」并列，改变${label}权重不会改变建议。`
        : `在 0–100% 全程，建议始终为「${idsToNames(draft, only.winnerIds)}」，改变${label}权重不会改变建议。`,
    );
  }
  return notices;
}

/* ------------------------------------------------------------------ */
/* 入口                                                                 */
/* ------------------------------------------------------------------ */

export function analyzeAt(
  draft: DecisionDraft,
  base: Tenths,
  dimension: ValueKey,
  index: number,
  mode: AdjustmentMode,
): ProbeResult {
  const clamped = Math.max(0, Math.min(GRID_END, Math.round(index)));
  const weights = tenthsToPercents(reweight(base, dimension, clamped, mode));
  return { index: clamped, weights, analysis: analyzeWithWeights(draft, weights) };
}

export function runSensitivity(
  draft: DecisionDraft,
  dimension: ValueKey,
  mode: AdjustmentMode,
  strategy: ScanStrategy,
  version: number,
): SensitivityReport {
  const base = quantizeBase(draft.weights);
  const othersSum = VALUE_KEYS.filter((k) => k !== dimension).reduce((n, k) => n + base[k], 0);
  const fallbackEven = mode === 'proportional' && othersSum === 0;
  const effectiveMode: AdjustmentMode = fallbackEven ? 'even' : mode;

  const ctx: ScanContext = {
    draft,
    base,
    dimension,
    mode: effectiveMode,
    cache: new Map(),
    rawCache: new Map(),
    evaluations: 0,
  };

  const built =
    strategy === 'exact' ? runExact(ctx) : strategy === 'coarse' ? runCoarse(ctx) : runAdaptive(ctx);

  const segments: SensitivitySegment[] = built.map((s) => ({
    startIndex: s.startIndex,
    endIndex: s.endIndex,
    winnerIds: s.winnerIds,
    tie: s.tie,
    verified: s.verified,
  }));
  const turningPoints = deriveTurningPoints(built);

  const partial: Omit<SensitivityReport, 'notices'> = {
    dimension,
    mode: effectiveMode,
    strategy,
    baseTenths: base,
    basePercents: tenthsToPercents(base),
    segments,
    turningPoints,
    evaluationCount: ctx.evaluations,
    version,
  };
  return { ...partial, notices: buildNotices(draft, partial, fallbackEven) };
}

export function describeOutcome(draft: DecisionDraft, ids: string[], tie: boolean): string {
  if (ids.length === 0) return '未验证区间';
  return tie ? `${idsToNames(draft, ids)} 并列` : `「${idsToNames(draft, ids)}」独占`;
}
