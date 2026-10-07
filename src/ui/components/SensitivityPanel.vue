<script setup lang="ts">
import{computed,ref,watch}from'vue';
import{VALUE_KEYS,VALUE_LABELS,type DecisionAnalysis,type ValueKey,type ValueWeights,type OptionAnalysis}from'../../core/models';
import{
  analyzeSensitivity,createWeightPath,trialAt,MICRO_MERGE_TOLERANCE,
  type ReallocationMode,type RankingState,type SensitivityResult,type StateSegment
}from'../../core/sensitivity';

const props=defineProps<{analysis:DecisionAnalysis;stale:boolean}>();
const emit=defineEmits<{apply:[weights:ValueWeights]}>();

const target=ref<ValueKey>('growth');
const modeName=ref<'proportional'|'locked'|'equal'>('proportional');
const bearer=ref<ValueKey>('money');
const result=ref<SensitivityResult|null>(null);
const trialX=ref<number|null>(null);
const panelError=ref<string>('');

const mode=computed<ReallocationMode>(()=>modeName.value==='locked'?{kind:'locked',bearer:bearer.value}:{kind:modeName.value});
const options=computed(()=>props.analysis.options.map(o=>o.option));
const baseWeights=computed<ValueWeights>(()=>props.analysis.weights);
const otherKeys=computed(()=>VALUE_KEYS.filter(k=>k!==target.value));

function recompute(){
  panelError.value='';
  if(props.stale){result.value=null;trialX.value=null;return}
  try{
    result.value=analyzeSensitivity(options.value,baseWeights.value,target.value,mode.value);
    trialX.value=null;
  }catch(e){panelError.value=e instanceof Error?e.message:'试探失败';result.value=null}
}

watch([target,modeName,bearer,()=>props.analysis],recompute,{immediate:true});
// 重新推演（新 analysis 对象）或方案编辑后按 stale 重建/清空
watch(()=>props.stale,v=>{if(v){result.value=null;trialX.value=null}else recompute()});

const path=computed(()=>createWeightPath(baseWeights.value,target.value,mode.value));
const trial=computed(()=>trialX.value===null?null:trialAt(options.value,path.value,trialX.value));

const palette:Record<string,string>={};
props.analysis.options.forEach((o,i)=>{palette[o.option.id]=['#4f5db7','#d58a32','#8b5f88','#3b8667'][i]});
const optionName=(id:string)=>props.analysis.options.find(o=>o.option.id===id)?.option.name??id;
function stateLabel(s:RankingState):string{
  return s.kind==='winner'?`${optionName(s.optionId)} 唯一领先`:s.members.map(optionName).join('、')+' 接近（并列）';
}
function stateColor(s:RankingState):string{
  return s.kind==='winner'?(palette[s.optionId]??'#888'):'#c9c3ad';
}
/** 分带代表状态：并列累计宽度达到容差时以并列为主，不强行画唯一胜者；否则以主导胜者显示。 */
type BandView={states:RankingState[];mixed:boolean;tieWidth:number};
function bandPrimary(b:BandView):RankingState{
  if(b.tieWidth>=MICRO_MERGE_TOLERANCE)return b.states.find(s=>s.kind==='tie')??b.states[0];
  return b.states.find(s=>s.kind==='winner')??b.states[0];
}
function bandIsTie(b:BandView):boolean{return bandPrimary(b).kind==='tie'}
function bandLabel(b:BandView):string{
  const main=stateLabel(bandPrimary(b));
  return b.mixed?`${main}（边界附近有短暂切换，见明细）`:main;
}
const fmt=(x:number)=>Math.abs(x-Math.round(x))<0.02?String(Math.round(x)):x.toFixed(2);
const bandTitle=(b:{from:number;to:number;states:RankingState[];mixed:boolean})=>
  `${fmt(b.from)}%–${fmt(b.to)}%：${b.states.map(stateLabel).join('；')}`;

// 轨道几何
const W=760,H=64,PADL=8,PADR=8;
const px=(x:number)=>PADL+x/100*(W-PADL-PADR);

function startTrial(x:number){
  trialX.value=Math.max(0,Math.min(100,Math.round(x*10)/10));
}
function jumpSegment(g:StateSegment){startTrial(Math.min(99.99,Math.max(0.01,(g.from+g.to)/2)))}
function jumpTransition(at:number){startTrial(Math.min(99.99,Math.max(0.01,at+0.05)))}
function applyTrial(){
  if(trial.value){emit('apply',path.value.weightsAt(trialX.value!));trialX.value=null}
}
function dismissTrial(){trialX.value=null}

// 试探结果按当前分析的选项顺序对齐，便于对比名次变化
interface TrialRow{name:string;color:string;before:OptionAnalysis;after:OptionAnalysis;beforeRank:number;afterRank:number}
const compareRows=computed<TrialRow[]>(()=>{
  if(!trial.value)return[];
  return props.analysis.options.map((row,beforeRank)=>{
    const after=trial.value!.ranked.findIndex(r=>r.option.id===row.option.id);
    return{
      name:row.option.name,color:palette[row.option.id]??'#888',
      before:row,after:trial.value!.ranked[after],beforeRank,afterRank:after+1
    };
  });
});

const modeHint=computed(()=>{
  if(modeName.value==='proportional')return'其余三个维度按当前相对比例共同让出（或吸收）变化。当前只看该维度时退化为均摊。';
  if(modeName.value==='equal')return'其余三个维度平均分摊全部变化。';
  return`优先由「${VALUE_LABELS[bearer.value]}」单独承担；它被压到 0 后，不足部分再由其余维度按当前比例分摊。`;
});
</script>

<template>
  <section class="paper-panel sensitivity">
    <span class="index">SENSITIVITY / TURNNING POINTS</span>
    <h2>权重要变到什么程度，建议才会改变？</h2>
    <p class="sen-intro">
      基于<strong>本次推演的选项快照与同一套评分规则</strong>逐点真实计算，不做图形插值。
      色带表示该权重区间内的建议状态；斜纹带为差距 &lt;5 分的接近（并列）区间，不强行指定唯一胜者。
    </p>

    <div v-if="stale" class="stale-note">方案已修改，旧的敏感性结果已失效，请重新推演后再试探。</div>

    <template v-else>
      <div class="sen-controls">
        <label>试探维度
          <select v-model="target">
            <option v-for="k in VALUE_KEYS" :key="k" :value="k">{{VALUE_LABELS[k]}}（当前 {{Math.round(baseWeights[k]*10)/10}}%）</option>
          </select>
        </label>
        <label>其余权重如何调整
          <select v-model="modeName">
            <option value="proportional">按当前比例分摊（推荐）</option>
            <option value="locked">由一个维度承担</option>
            <option value="equal">其余三维均摊</option>
          </select>
        </label>
        <label v-if="modeName==='locked'">承担维度
          <select v-model="bearer">
            <option v-for="k in otherKeys" :key="k" :value="k">{{VALUE_LABELS[k]}}</option>
          </select>
        </label>
      </div>
      <p class="sen-hint">{{modeHint}}</p>
      <p v-if="panelError" class="sen-error">{{panelError}}</p>

      <div v-if="result" class="sen-axis-wrap">
        <!-- 状态轴 -->
        <svg class="sen-axis" :viewBox="`0 0 ${W} ${H+26}`" role="img" :aria-label="`${VALUE_LABELS[target]}权重从 0 到 100 时的建议分段`">
          <defs>
            <pattern id="sen-tie-pattern" patternUnits="userSpaceOnUse" width="7" height="7" patternTransform="rotate(45)">
              <rect width="7" height="7" fill="#d8d2bb"/>
              <rect width="3" height="7" fill="#b3ad96"/>
            </pattern>
          </defs>
          <!-- 显示分带（真实窄带保留；舍入微抖动已并入并在 title/清单中注明） -->
          <g v-for="(b,i) in result.bands" :key="i" class="sen-seg" @click="jumpSegment({from:b.from,to:b.to} as StateSegment)">
            <rect :x="px(b.from)" :y="10" :width="Math.max(1,px(b.to)-px(b.from))" :height="H-20"
                  :fill="bandIsTie(b)?'url(#sen-tie-pattern)':stateColor(bandPrimary(b))"
                  :stroke-opacity="b.mixed?0.7:1">
              <title>{{bandTitle(b)}}</title>
            </rect>
            <line v-if="b.mixed" :x1="px(b.from)+3" :x2="px(b.to)-3" y1="20" y2="20" stroke="#292a30" stroke-width="1" stroke-dasharray="2 3" opacity=".55"/>
          </g>
          <!-- 孤立点状态（精确折点上的并列等） -->
          <g v-for="(p,i) in result.points" :key="`p${i}`">
            <line :x1="px(p.x)" x2="0" :y1="4" :y2="H-4" :stroke="stateColor(p.state)" stroke-width="2" stroke-dasharray="3 3"/>
            <circle :cx="px(p.x)" :cy="H/2" r="4" :fill="stateColor(p.state)" stroke="#292a30" stroke-width="1">
              <title>{{fmt(p.x)}}%（恰为此值）：{{stateLabel(p.state)}}</title>
            </circle>
          </g>
          <!-- 转折刻度 -->
          <g v-for="(t,i) in result.transitions" :key="`t${i}`" class="sen-cut" @click="jumpTransition(t.at)">
            <line :x1="px(t.at)" :x2="px(t.at)" :y1="2" :y2="H-2" stroke="#292a30" stroke-width="1.4"/>
            <text :x="px(t.at)" :y="H+18" text-anchor="middle" class="sen-cut-label">{{fmt(t.at)}}%</text>
            <title>{{fmt(t.at)}}%：{{stateLabel(t.from)}} → {{stateLabel(t.to)}}</title>
          </g>
          <!-- 当前权重位置 -->
          <line :x1="px(baseWeights[target])" :x2="px(baseWeights[target])" y1="0" :y2="H" stroke="#292a30" stroke-width="2.4"/>
          <text :x="px(baseWeights[target])" y="9" text-anchor="middle" class="sen-now-label">当前 {{fmt(baseWeights[target])}}%</text>
          <!-- 试探位置 -->
          <g v-if="trialX!==null">
            <line :x1="px(trialX)" :x2="px(trialX)" y1="0" :y2="H" stroke="#b3402a" stroke-width="2.4" stroke-dasharray="5 3"/>
            <text :x="px(trialX)" :y="9" text-anchor="middle" class="sen-trial-label">试探 {{fmt(trialX)}}%</text>
          </g>
        </svg>
        <div class="sen-ends"><span>0% — 完全不考虑{{VALUE_LABELS[target]}}</span><span>100% — 只考虑{{VALUE_LABELS[target]}}</span></div>

        <!-- 图例 -->
        <div class="sen-legend">
          <i v-for="o in analysis.options" :key="o.option.id"><b :style="{background:palette[o.option.id]}"></b>{{o.option.name}}</i>
          <i><b class="tie-swatch"></b>接近 / 并列（前两名差距 &lt;5 分）</i>
        </div>

        <!-- 转折点清单 -->
        <div class="sen-turns">
          <template v-if="result.unchanged">
            <p class="sen-nochange">在 0–100% 的整个范围内，建议都不会改变：{{stateLabel(result.segments[0].state)}}。该维度对当前方案的建议不敏感。</p>
          </template>
          <template v-else>
            <h4>建议转折点（{{result.transitions.length}} 处主要转折，并列区间 {{result.bands.filter(b=>bandIsTie(b)).length}} 段<template v-if="result.microCuts.length">；另有 {{result.microCuts.length}} 处边界微切换，见下方明细</template>）</h4>
            <ol>
              <li v-for="(t,i) in result.transitions" :key="i">
                <button @click="jumpTransition(t.at)">
                  <b>{{VALUE_LABELS[target]}}越过 {{fmt(t.at)}}%</b>
                  <span>{{stateLabel(t.from)}} → {{stateLabel(t.to)}}</span>
                  <em v-if="t.point">恰为 {{fmt(t.at)}}% 时：{{stateLabel(t.point)}}</em>
                </button>
              </li>
            </ol>
            <details v-if="result.microCuts.length" class="sen-micro">
              <summary>为什么有些切换只差 0.0x 个百分点？</summary>
              <p>总分是各时间点整数分按 30/40/30 加权的结果。在两条总分曲线相差恰好 5 分的边界附近，
                一位小数的权重归一化会让整数分在极窄的权重范围内来回跳变。以下精确切换都由真实评分得到（不是插值），
                但宽度小于 {{MICRO_MERGE_TOLERANCE}} 个百分点，实际决策可视为同一段：</p>
              <ul>
                <li v-for="(c,i) in result.microCuts" :key="i">
                  <button @click="startTrial(c.at)">{{fmt(c.at)}}%：{{stateLabel(c.from)}} ↔ {{stateLabel(c.to)}}</button>
                </li>
              </ul>
            </details>
          </template>
        </div>

        <!-- 分段得分速览（显示分带） -->
        <details class="sen-segments">
          <summary>查看各权重区间的总分（真实评分，非插值）</summary>
          <ul>
            <li v-for="(b,i) in result.bands" :key="i">
              <button @click="jumpSegment({from:b.from,to:b.to} as StateSegment)">
                <i :class="{tie:bandIsTie(b)}" :style="!bandIsTie(b)?{background:stateColor(bandPrimary(b))}:{}"></i>
                <b>{{fmt(b.from)}}% – {{fmt(b.to)}}%</b>
                <span>{{bandLabel(b)}}</span>
                <small>{{b.ranked.map(o=>`${o.option.name} ${o.total}`).join('　')}}</small>
              </button>
            </li>
          </ul>
        </details>

        <!-- 临时试探 -->
        <div class="sen-probe">
          <h4>临时套用某个位置对比（不会修改你的权重）</h4>
          <input type="range" min="0" max="100" step="0.1" :value="trialX??baseWeights[target]"
                 @input="startTrial(Number(($event.target as HTMLInputElement).value))"/>
          <div class="sen-probe-actions">
            <button v-if="trialX!==null" @click="dismissTrial">放弃试探</button>
            <button class="primary" v-if="trialX!==null" @click="applyTrial">套用 {{fmt(trialX!)}}% 这组权重并重新推演</button>
            <span v-else>拖动滑块，或点击色带 / 转折点直接定位。</span>
          </div>

          <table v-if="trial" class="sen-compare">
            <thead><tr><th>选项</th><th>当前总分（名次）</th><th>试探总分（名次）</th><th>变化</th></tr></thead>
            <tbody>
              <tr v-for="row in compareRows" :key="row.name">
                <td><i :style="{background:row.color}"></i>{{row.name}}</td>
                <td>{{row.before.total}}（#{{row.beforeRank+1}}）</td>
                <td>{{row.after.total}}（#{{row.afterRank}}）</td>
                <td :class="{up:row.after.total<row.before.total,down:row.after.total>row.before.total}">
                  {{row.after.total-row.before.total>0?'+':''}}{{row.after.total-row.before.total}}
                  <em v-if="row.afterRank!==row.beforeRank+1">名次 {{row.beforeRank+1}}→{{row.afterRank}}</em>
                </td>
              </tr>
            </tbody>
          </table>
          <p v-if="trial" class="sen-trial-reco">试探建议：{{trial.recommendation}}</p>
          <ul v-if="trial" class="sen-trial-weights">
            <li v-for="k in VALUE_KEYS" :key="k"><b :class="{on:k===target}">{{VALUE_LABELS[k]}}</b>{{Math.round(trial.weights[k]*10)/10}}%</li>
          </ul>
        </div>
      </div>
    </template>
  </section>
</template>
