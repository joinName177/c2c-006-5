<script setup lang="ts">
import type { DecisionAnalysis, DecisionDraft, ValueKey } from '../../core/models';
import type { AdjustmentMode, ProbeResult, ScanStrategy, SensitivityReport } from '../../core/sensitivity-service';
import RegretCurve from './RegretCurve.vue';
import SensitivityPanel from './SensitivityPanel.vue';

defineProps<{
  analysis: DecisionAnalysis;
  draft: DecisionDraft;
  stale: boolean;
  report?: SensitivityReport;
  probe?: ProbeResult & { mode: AdjustmentMode; dimension: ValueKey };
  sensitivityVersion: number;
}>();

const emit = defineEmits<{
  generate: [dimension: ValueKey, mode: AdjustmentMode, strategy: ScanStrategy];
  probe: [dimension: ValueKey, mode: AdjustmentMode, index: number];
  clearProbe: [];
  applyProbe: [];
}>();
</script>

<template>
  <section class="results">
    <div v-if="stale" class="stale-note">输入已变化，下方是上一次分析结果，请重新计算。</div>
    <div class="recommendation">
      <span>THE LEAST REGRETFUL PATH</span>
      <h2>最不后悔建议</h2>
      <p>{{ analysis.recommendation }}</p>
      <aside v-for="notice in analysis.notices" :key="notice">{{ notice }}</aside>
    </div>
    <RegretCurve :options="analysis.options" />
    <div class="score-grid">
      <article v-for="(item,index) in analysis.options" :key="item.option.id">
        <span>#0{{ index + 1 }}</span>
        <h3>{{ item.option.name }}</h3>
        <b>{{ item.total }}<small>/100</small></b>
        <div>
          <i v-for="p in item.points" :key="p.horizon">{{ p.horizon }}年 {{ p.score }}</i>
        </div>
      </article>
    </div>
    <SensitivityPanel
      :draft="draft"
      :analysis="analysis"
      :report="report"
      :probe="probe"
      :version="sensitivityVersion"
      @generate="(d,m,s)=>emit('generate',d,m,s)"
      @probe="(d,m,i)=>emit('probe',d,m,i)"
      @clear-probe="emit('clearProbe')"
      @apply-probe="emit('applyProbe')"
    />
    <div class="rehearsals">
      <article v-for="item in analysis.options" :key="item.option.id">
        <h3>{{ item.option.name }} · 后悔预演</h3>
        <div v-for="card in item.cards" :key="card.horizon">
          <b>{{ card.horizon }} 年后</b>
          <p>{{ card.regret }}</p>
          <small>{{ card.trigger }} {{ card.reversibility }}；{{ card.action }}</small>
        </div>
      </article>
    </div>
  </section>
</template>
