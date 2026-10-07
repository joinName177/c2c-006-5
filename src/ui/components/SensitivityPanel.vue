<script setup lang="ts">
import { computed, ref, watch } from 'vue';import {
  VALUE_KEYS,
  VALUE_LABELS,
  type DecisionAnalysis,
  type DecisionDraft,
  type ValueKey,
} from '../../core/models';
import {
  describeOutcome,
  type AdjustmentMode,
  type ProbeResult,
  type ScanStrategy,
  type SensitivityReport,
} from '../../core/sensitivity-service';

const props = defineProps<{
  draft: DecisionDraft;
  analysis: DecisionAnalysis;
  report?: SensitivityReport;
  probe?: ProbeResult & { mode: AdjustmentMode; dimension: ValueKey };
  version: number;
}>();

const emit = defineEmits<{
  generate: [dimension: ValueKey, mode: AdjustmentMode, strategy: ScanStrategy];
  probe: [dimension: ValueKey, mode: AdjustmentMode, index: number];
  clearProbe: [];
  applyProbe: [];
}>();

const dimension = ref<ValueKey>(VALUE_KEYS[0]);
const mode = ref<AdjustmentMode>('proportional');
const strategy = ref<ScanStrategy>('adaptive');
const probePercent = ref(0);

const COLORS = ['#4f5db7', '#d58a32', '#8b5f88', '#3b8667'];
const optionIndex = (id: string) => Math.max(0, props.draft.options.findIndex((o) => o.id === id));
const colorOf = (id: string) => COLORS[optionIndex(id)];

/** 报告必须版本最新，且与面板上当前选择的维度/方式/策略一致；选择一变，旧结论即视为过期。 */
const reportValid = computed(
  () =>
    Boolean(props.report) &&
    props.report!.version === props.version &&
    props.report!.dimension === dimension.value &&
    props.report!.mode === mode.value &&
    props.report!.strategy === strategy.value,
);

watch(
  () => props.report,
  (report) => {
    if (report) {
      dimension.value = report.dimension;
      mode.value = report.mode;
      strategy.value = report.strategy;
    }
  },
);

watch(
  () => props.probe,
  (p) => {
    if (p) probePercent.value = Math.round(p.index) / 10;
  },
);

// 面板上的选择或方案版本变化后，旧试探不再对应当前上下文
watch([dimension, mode, () => props.version], () => {
  if (props.probe) emit('clearProbe');
});

const basePercent = computed(() =>
  props.report ? props.report.basePercents[dimension.value] : 0,
);

const expiredReason = computed(() => {
  if (!props.report) return '';
  if (props.report.version !== props.version) return '方案已被重新编辑或重新推演，以下敏感性结论基于旧版本，已失效；请重新生成。';
  if (!reportValid.value) return '观察维度、调整方式或扫描方法已改变，请基于当前选择重新生成。';
  return '';
});

interface RenderedSegment {
  x: number;
  width: number;
  fill: string;
  pattern: boolean;
  unverified: boolean;
  label: string;
  midIndex: number;
  startPercent: number;
  endPercent: number;
}

const rendered = computed<RenderedSegment[]>(() => {
  if (!props.report || !reportValid.value) return [];
  return props.report.segments.map((s) => {
    const width = Math.max(2, s.endIndex - s.startIndex + 1);
    const midIndex = Math.round((s.startIndex + s.endIndex) / 2);
    const label = s.verified
      ? describeOutcome(props.draft, s.winnerIds, s.tie)
      : '未验证间隔';
    if (!s.verified) {
      return {
        x: s.startIndex,
        width,
        fill: '#b8b4a8',
        pattern: true,
        unverified: true,
        label,
        midIndex,
        startPercent: s.startIndex / 10,
        endPercent: s.endIndex / 10,
      };
    }
    if (s.tie) {
      return {
        x: s.startIndex,
        width,
        fill: `tie-${s.winnerIds[0]}-${s.winnerIds[1]}`,
        pattern: true,
        unverified: false,
        label,
        midIndex,
        startPercent: s.startIndex / 10,
        endPercent: s.endIndex / 10,
      };
    }
    return {
      x: s.startIndex,
      width,
      fill: colorOf(s.winnerIds[0]),
      pattern: false,
      unverified: false,
      label,
      midIndex,
      startPercent: s.startIndex / 10,
      endPercent: s.endIndex / 10,
    };
  });
});

const tiePatterns = computed(() => {
  const pairs = new Map<string, [string, string]>();
  if (props.report && reportValid.value) {
    for (const s of props.report.segments) {
      if (s.tie) pairs.set(`tie-${s.winnerIds[0]}-${s.winnerIds[1]}`, [colorOf(s.winnerIds[0]), colorOf(s.winnerIds[1])]);
    }
  }
  return Array.from(pairs.entries()).map(([id, [a, b]]) => ({ id, a, b }));
});

function onTrackClick(event: MouseEvent) {
  if (!reportValid.value) return;
  const target = event.currentTarget as SVGElement;
  const rect = target.getBoundingClientRect();
  const ratio = (event.clientX - rect.left) / rect.width;
  const index = Math.max(0, Math.min(1000, Math.round(ratio * 1000)));
  probePercent.value = index / 10;
  emit('probe', dimension.value, mode.value, index);
}

function onSlider(event: Event) {
  const value = Number((event.target as HTMLInputElement).value);
  probePercent.value = value;
  emit('probe', dimension.value, mode.value, Math.round(value * 10));
}

function probeAt(index: number) {
  probePercent.value = index / 10;
  emit('probe', dimension.value, mode.value, index);
}

function regenerate() {
  emit('generate', dimension.value, mode.value, strategy.value);
}

const probeWeightsRows = computed(() =>
  VALUE_KEYS.map((k) => ({
    key: k,
    label: VALUE_LABELS[k],
    base: props.report ? props.report.basePercents[k] : props.draft.weights[k],
    probe: props.probe ? props.probe.weights[k] : null as number | null,
  })),
);

const compareRows = computed(() => {
  if (!props.probe) return [];
  return props.draft.options.map((o) => {
    const base = props.analysis.options.find((x) => x.option.id === o.id);
    const tried = props.probe!.analysis.options.find((x) => x.option.id === o.id);
    return {
      id: o.id,
      name: o.name,
      color: colorOf(o.id),
      baseTotal: base?.total ?? 0,
      probeTotal: tried?.total ?? 0,
      delta: (tried?.total ?? 0) - (base?.total ?? 0),
    };
  });
});

function isProbedWinner(id: string) {
  return props.probe?.analysis.winnerId === id;
}
function isProbedTied(id: string) {
  if (!props.probe || props.probe.analysis.winnerId !== undefined) return false;
  return props.probe.analysis.options.slice(0, 2).some((o) => o.option.id === id);
}
function isBaseWinner(id: string) {
  return props.analysis.winnerId === id;
}
function isBaseTied(id: string) {
  if (props.analysis.winnerId !== undefined) return false;
  return props.analysis.options.slice(0, 2).some((o) => o.option.id === id);
}
</script>

<template>
  <section class="paper-panel sensitivity">
    <span class="index">03 / SENSITIVITY</span>
    <h2>权重改变到什么程度，建议才会变？</h2>
    <p class="sens-intro">
      选定一个价值维度，把它的权重从 0% 调到 100%，区间条显示每个权重下由同一规则引擎复算出的建议。
      并列结果以双色斜纹显示，不会被画成唯一胜者。
    </p>

    <div v-if="expiredReason" class="sens-expired">
      {{ expiredReason }}
    </div>

    <div class="sens-controls">
      <div class="sens-group">
        <small>观察维度</small>
        <div class="sens-chips">
          <button
            v-for="k in VALUE_KEYS"
            :key="k"
            :class="{ active: dimension === k }"
            @click="dimension = k"
          >
            {{ VALUE_LABELS[k] }}
          </button>
        </div>
      </div>
      <div class="sens-group">
        <small>其余三维度如何让出权重</small>
        <div class="sens-chips">
          <button :class="{ active: mode === 'proportional' }" @click="mode = 'proportional'">
            等比缩放（保持相对比例）
          </button>
          <button :class="{ active: mode === 'even' }" @click="mode = 'even'">
            平均分摊（一视同仁）
          </button>
        </div>
      </div>
      <div class="sens-group">
        <small>转折点寻找方法</small>
        <div class="sens-chips">
          <button :class="{ active: strategy === 'adaptive' }" @click="strategy = 'adaptive'">
            智能细化（默认）
          </button>
          <button :class="{ active: strategy === 'exact' }" @click="strategy = 'exact'">
            精确扫描（0.1% 全量 1001 点）
          </button>
          <button :class="{ active: strategy === 'coarse' }" @click="strategy = 'coarse'">
            固定粗扫（5%，对照用）
          </button>
        </div>
      </div>
      <button class="sens-generate" @click="regenerate">生成敏感性结论 ↗</button>
    </div>

    <template v-if="report && reportValid">
      <ul class="sens-notes">
        <li v-for="(notice, i) in report.notices" :key="i">{{ notice }}</li>
      </ul>

      <div class="sens-track-wrap">
        <div class="sens-axis"><span>0%</span><span>{{ VALUE_LABELS[report.dimension] }}权重 →</span><span>100%</span></div>
        <svg
          class="sens-track"
          viewBox="0 0 1000 56"
          preserveAspectRatio="none"
          role="img"
          aria-label="建议随权重变化的区间"
          @click="onTrackClick"
        >
          <defs>
            <pattern
              v-for="p in tiePatterns"
              :id="`pat-${p.id}`"
              :key="p.id"
              width="10"
              height="10"
              patternTransform="rotate(45)"
              patternUnits="userSpaceOnUse"
            >
              <rect width="10" height="10" :fill="p.a" />
              <rect width="5" height="10" :fill="p.b" />
            </pattern>
            <pattern id="pat-unknown" width="8" height="8" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
              <rect width="8" height="8" fill="#d8d5cb" />
              <rect width="3" height="8" fill="#b0aca0" />
            </pattern>
          </defs>
          <rect x="0" y="0" width="1000" height="56" fill="#eae7dd" />
          <g v-for="(s, i) in rendered" :key="i">
            <rect
              :x="s.x"
              y="4"
              :width="s.width - 1"
              height="48"
              :fill="s.pattern ? (s.unverified ? 'url(#pat-unknown)' : `url(#pat-${s.fill})`) : s.fill"
              stroke="#f8f6ef"
              stroke-width="1"
            >
              <title>{{ s.startPercent }}%–{{ s.endPercent }}%：{{ s.label }}</title>
            </rect>
          </g>
          <line
            v-if="probe"
              :x1="probe.index"
              :x2="probe.index"
              y1="0"
              y2="56"
              stroke="#292a30"
              stroke-width="2"
            />
          <line
            :x1="Math.round(basePercent * 10)"
            :x2="Math.round(basePercent * 10)"
            y1="0"
            y2="56"
            stroke="#f8f6ef"
            stroke-width="2"
            stroke-dasharray="4 4"
          />
        </svg>
        <div class="sens-markers">
          <span>◀ 点击区间条任意位置可临时套用该权重（白虚线为当前基准 {{ basePercent }}%）</span>
        </div>
      </div>

      <div class="sens-legend">
        <span v-for="(o, i) in draft.options" :key="o.id">
          <i :style="{ background: COLORS[i] }"></i>{{ o.name }}
        </span>
        <span><i class="swatch tie-a"></i>斜纹 = 两选项并列（差距 &lt;5 分）</span>
        <span v-if="report.strategy === 'coarse'"><i class="swatch unknown"></i>灰斜纹 = 粗扫未验证区间</span>
      </div>

      <div class="sens-turns">
        <h3>转折点（共 {{ report.turningPoints.length }} 个）</h3>
        <p v-if="report.turningPoints.length === 0" class="sens-empty">
          在可达的 0–100% 权重范围内没有建议变化。
        </p>
        <article v-for="(t, i) in report.turningPoints" :key="i">
          <b>{{ t.percent.toFixed(1) }}%</b>
          <span>
            恰为该权重时：{{ describeOutcome(draft, t.beforeIds, t.beforeTie) }}
            → <em>{{ describeOutcome(draft, t.afterIds, t.afterTie) }}</em>
          </span>
          <button @click="probeAt(t.index)">临时套用</button>
        </article>
      </div>

      <div class="sens-probe">
        <h3>临时套用对比（不改动当前方案）</h3>
        <label class="sens-slider">
          {{ VALUE_LABELS[dimension] }}权重 <b>{{ probePercent.toFixed(1) }}%</b>
          <input
            type="range"
            min="0"
            max="100"
            step="0.1"
            :value="probePercent"
            @input="onSlider"
          />
        </label>
        <p v-if="!probe" class="sens-empty">拖动滑块或点击上方区间条，可临时套用某个权重，与当前基准并排对比；试探不会改动方案。</p>

        <div v-if="probe" class="probe-grid">
          <div class="probe-col">
            <small>当前基准 · {{ VALUE_LABELS[dimension] }} {{ basePercent.toFixed(1) }}%</small>
            <p>{{ analysis.recommendation }}</p>
            <ul>
              <li v-for="row in compareRows" :key="`b-${row.id}`" :class="{ win: isBaseWinner(row.id), tie: isBaseTied(row.id) }">
                <i :style="{ background: row.color }"></i>{{ row.name }}
                <b>{{ row.baseTotal }}</b>
              </li>
            </ul>
          </div>
          <div class="probe-arrow">→</div>
          <div class="probe-col tried">
            <small>试探权重 · {{ VALUE_LABELS[dimension] }} {{ (probe.index / 10).toFixed(1) }}%</small>
            <p>{{ probe.analysis.recommendation }}</p>
            <ul>
              <li v-for="row in compareRows" :key="`p-${row.id}`" :class="{ win: isProbedWinner(row.id), tie: isProbedTied(row.id) }">
                <i :style="{ background: row.color }"></i>{{ row.name }}
                <b>{{ row.probeTotal }}</b>
                <em v-if="row.delta !== 0" :class="{ up: row.delta > 0, down: row.delta < 0 }">
                  {{ row.delta > 0 ? '+' : '' }}{{ row.delta }}
                </em>
              </li>
            </ul>
          </div>
        </div>

        <div v-if="probe" class="probe-weights">
          <span v-for="row in probeWeightsRows" :key="row.key">
            {{ row.label }} {{ row.base.toFixed(1) }}% → <b>{{ row.probe?.toFixed(1) }}%</b>
          </span>
        </div>

        <div v-if="probe" class="probe-actions">
          <button class="primary" @click="emit('applyProbe')">应用为新权重并重新推演</button>
          <button @click="emit('clearProbe')">放弃试探</button>
          <small>试探只用于对比，不会覆盖当前权重；只有点击“应用”才会写回方案。</small>
        </div>
      </div>
    </template>
  </section>
</template>
