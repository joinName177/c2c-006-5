import{rankOptions,recommendationFor,tryNormalize}from'./scoring';
import{VALUE_KEYS,type DecisionOption,type OptionAnalysis,type ValueKey,type ValueWeights}from'./models';

/** 其余权重的分摊方式。 */
export type ReallocationMode=
  |{kind:'proportional'}                 // 其余按当前比例分摊
  |{kind:'equal'}                        // 其余均摊
  |{kind:'locked';bearer:ValueKey};      // 指定一个维度承担

export interface WeightPath{
  target:ValueKey;
  mode:ReallocationMode;
  /** 0–100（单位：归一化百分比），返回该位置的原始权重向量（和为 100）。 */
  weightsAt(x:number):ValueWeights;
}

/**
 * 沿权重路径移动被试探维度 t 到 x（归一化百分比），其余维度按 mode 分摊差额。
 * b 为当前归一化权重快照。任意 x∈[0,100] 结果非负且和为 100。
 */
export function createWeightPath(b:ValueWeights,target:ValueKey,mode:ReallocationMode):WeightPath{
  const others=VALUE_KEYS.filter(k=>k!==target);
  const otherSum=others.reduce((s,k)=>s+b[k],0); // =100-b[target]
  const weightsAt=(x:number):ValueWeights=>{
    const raw={...b}as ValueWeights;
    const demand=x-b[target]; // >0 需要其余让出，<0 需要其余吸收
    if(mode.kind==='equal'){
      raw[target]=x;
      others.forEach(k=>{raw[k]=(100-x)/others.length});
      return raw;
    }
    if(mode.kind==='proportional'){
      raw[target]=x;
      if(otherSum>0){
        others.forEach(k=>{raw[k]=b[k]*(100-x)/otherSum});
      }else{
        // b[target]=100 时其余维度无原比例，退化为均摊
        others.forEach(k=>{raw[k]=(100-x)/others.length});
      }
      return raw;
    }
    // locked：bearer 先单独承担，承担不了（被压到 0 后仍有让出需求）再由其余按比例分
    const bearer=mode.bearer;
    const fillers=others.filter(k=>k!==bearer);
    const fillerBase=fillers.reduce((s,k)=>s+b[k],0);
    raw[target]=x;
    if(demand<=0){
      raw[bearer]=b[bearer]-demand;       // bearer 吸收，必然非负（b[bearer]-demand>=0）
      fillers.forEach(k=>{raw[k]=b[k]});
    }else{
      raw[bearer]=Math.max(0,b[bearer]-demand);
      const overflow=Math.max(0,demand-b[bearer]);
      if(overflow>0){
        if(fillerBase>0)fillers.forEach(k=>{raw[k]=b[k]*(1-overflow/fillerBase)});
        else fillers.forEach(k=>{raw[k]=(fillerBase-overflow)/fillers.length});
      }
    }
    return raw;
  };
  return{target,mode,weightsAt};
}

/** 路径的一段仿射区间：对每个维度 raw_k(x)=a_k·x+c_k。 */
interface AffinePiece{from:number;to:number;a:Record<ValueKey,number>;c:Record<ValueKey,number>}

/** 归一化中“保留一位小数”产生的权重折点集合（n_k=round10(raw_k)/10 在 0.05 间距处跳变）。 */
function roundingKinks(piece:AffinePiece):number[]{
  const out:number[]=[];
  for(const k of VALUE_KEYS){
    const slope=piece.a[k];
    if(slope===0)continue;
    // raw_k 只在段内实际取值范围上变化，仅枚举该范围跨过的 (j+0.5)/10
    const lo=Math.min(piece.a[k]*piece.from+piece.c[k],piece.a[k]*piece.to+piece.c[k]);
    const hi=Math.max(piece.a[k]*piece.from+piece.c[k],piece.a[k]*piece.to+piece.c[k]);
    const jLo=Math.max(0,Math.ceil(lo*10-0.5-1e-9));
    const jHi=Math.min(999,Math.floor(hi*10-0.5+1e-9));
    for(let j=jLo;j<=jHi;j++){
      const x=((j+0.5)/10-piece.c[k])/slope;
      if(x>piece.from+EPS&&x<piece.to-EPS)out.push(x);
    }
  }
  return out;
}

const EPS=1e-7;

/**
 * 构造路径的仿射分段。proportional/equal 全程一段；locked 在承担维度触 0 处分两段。
 * 段端点处直接用 weightsAt 取值反推 a、c，保证与真实路径完全一致。
 */
function pathPieces(path:WeightPath,b:ValueWeights):AffinePiece[]{
  const target=path.target;
  const w=(x:number)=>path.weightsAt(x);
  const pieceOf=(from:number,to:number):AffinePiece=>{
    const w0=w(from),w1=from===to?w0:w(to);
    const a={}as Record<ValueKey,number>,c={}as Record<ValueKey,number>;
    const span=to-from;
    for(const k of VALUE_KEYS){
      a[k]=span===0?0:(w1[k]-w0[k])/span;
      c[k]=w0[k]-a[k]*from;
    }
    return{from,to,a,c};
  };
  if(path.mode.kind!=='locked')return[pieceOf(0,100)];
  const bearer=path.mode.bearer;
  // piece 1：bearer 尚未触 0。demand=b[target]+...；触 0 位置 x*=b[target]+b[bearer]
  const xStar=b[target]+b[bearer];
  if(xStar<=0||xStar>=100)return[pieceOf(0,100)];
  return[pieceOf(0,xStar),pieceOf(xStar,100)];
}

/** 某位置的名次状态：唯一胜者，或与领先者差距 <5 的接近组（并列是一等状态）。 */
export type RankingState=
  |{kind:'winner';optionId:string}
  |{kind:'tie';members:string[]};

export interface StateSample{state:RankingState;ranked:OptionAnalysis[]}

/** 在路径位置 x 做一次真实评分（绝不靠插值猜名次）。 */
export function sampleState(options:DecisionOption[],path:WeightPath,x:number):StateSample|null{
  const normalized=tryNormalize(path.weightsAt(x));
  if(!normalized)return null;
  const ranked=rankOptions(options,normalized);
  if(ranked.length===0)return null;
  const gap=ranked[1]?ranked[1].total-ranked[0].total:Infinity;
  if(gap<5){
    // 与领先者差距 <5 的所有选项组成接近组（保留按分升序的顺序）
    const members=ranked.filter(o=>o.total-ranked[0].total<5).map(o=>o.option.id);
    return{state:{kind:'tie',members},ranked};
  }
  return{state:{kind:'winner',optionId:ranked[0].option.id},ranked};
}

export function stateKey(state:RankingState):string{
  return state.kind==='winner'?`w:${state.optionId}`:`t:${state.members.join('+')}`;
}

export interface StateSegment{from:number;to:number;state:RankingState;ranked:OptionAnalysis[]}
export interface PointState{x:number;state:RankingState;ranked:OptionAnalysis[];isolated:boolean}
export interface Transition{at:number;from:RankingState;to:RankingState;point?:RankingState}
/**
 * 显示分带：整数舍入会在 5 分边界附近产生极窄（如 0.02pp）的微段抖动。
 * 分带把“被总宽 < mergeTolerance 的微切换隔开”的相邻段合并为一条带子，
 * 同时在 microCuts 里保留每个精确切换点——既不淹没真实窄区间，也不让舍入噪声画满整条轴。
 */
export interface DisplayBand{from:number;to:number;states:RankingState[];ranked:OptionAnalysis[];mixed:boolean;tieWidth:number}
export interface SensitivityResult{
  target:ValueKey;
  mode:ReallocationMode;
  segments:StateSegment[];
  points:PointState[];          // 候选点真实状态，isolated 表示与两侧都不同（如精确折点上的并列）
  transitions:Transition[];
  bands:DisplayBand[];          // 合并微切换后的显示分带（精确分段仍在 segments/transitions）
  microCuts:{at:number;from:RankingState;to:RankingState}[];
  evaluations:number;           // 结构法实际评分次数
  unchanged:boolean;            // 整条 0–100 轴建议是否不变
}

/** 小于该宽度（百分点）的断续切换视为舍入边界抖动，并入相邻分带。 */
export const MICRO_MERGE_TOLERANCE=0.5;

/**
 * 由精确分段构造显示分带。规则（保护真实窄区间）：
 * - 只有“自身宽度 < 容差、且左右邻居状态相同”的段才判为舍入边界抖动，并入邻居分带；
 * - 其余窄段（如被两个不同胜者夹住的窄并列带）原样保留，绝不合并；
 * - 被并入的抖动点记入 microCuts，精确切换不丢失。
 */
function buildDisplayBands(segments:StateSegment[]):{bands:DisplayBand[];microCuts:Transition[]}{
  const microCuts:Transition[]=[];
  if(segments.length===0)return{bands:[],microCuts};
  // jitter：自身窄、且左右邻居状态相同的段（舍入边界噪声），视觉并进当前分带
  const jitter=new Set<number>();
  for(let i=1;i<segments.length-1;i++){
    const g=segments[i];
    if(g.to-g.from<MICRO_MERGE_TOLERANCE&&stateKey(segments[i-1].state)===stateKey(segments[i+1].state)){
      jitter.add(i);
    }
  }
  const bands:DisplayBand[]=[];
  for(let i=0;i<segments.length;i++){
    const g=segments[i];
    if(jitter.has(i)){
      microCuts.push({at:g.from,from:segments[i-1].state,to:g.state});
      const last=bands[bands.length-1];
      last.to=g.to; // 视觉并进前一条分带
      if(!last.states.some(s=>stateKey(s)===stateKey(g.state)))last.states.push(g.state);
      if(g.state.kind==='tie')last.tieWidth+=g.to-g.from;
      last.mixed=last.states.length>1;
      continue;
    }
    bands.push({from:g.from,to:g.to,states:[g.state],ranked:g.ranked,mixed:false,tieWidth:g.state.kind==='tie'?g.to-g.from:0});
  }
  return{bands,microCuts};
}

/**
 * 方法 C：结构枚举。
 * 权重路径逐段仿射，单维归一化权重只在 round10 折点跳变，故所有选项整数总分
 * 在相邻折点之间恒定。枚举全部折点，在每个开区间中点做一次真实评分即可无遗漏分段。
 */
export function analyzeSensitivity(
  options:DecisionOption[],
  b:ValueWeights,
  target:ValueKey,
  mode:ReallocationMode
):SensitivityResult{
  const path=createWeightPath(b,target,mode);
  const pieces=pathPieces(path,b);
  // 候选点：0、100、段端点（locked 触 0）、各段内所有一位小数舍入折点
  const rawCands:number[]=[0,100];
  for(const piece of pieces){
    if(piece.from>0&&piece.from<100)rawCands.push(piece.from);
    roundingKinks(piece).forEach(x=>rawCands.push(x));
  }
  // 容差去重（locked 折点可能与某个舍入折点数值重合）
  const xs=rawCands.filter(x=>x>=-EPS&&x<=100+EPS).sort((p,q)=>p-q).reduce<number[]>((acc,x)=>{
    if(!acc.length||x-acc[acc.length-1]>1e-6)acc.push(x);
    else if(Math.abs(x-100)<Math.abs(acc[acc.length-1]-100))acc[acc.length-1]=x;
    return acc;
  },[]);
  let evaluations=0;
  const pointSamples=new Map<number,StateSample>();
  for(const x of xs){
    const s=sampleState(options,path,x);
    evaluations++;
    if(s)pointSamples.set(x,s);
  }
  // 每个相邻候选点之间的开区间取中点取样（区间内舍入后的权重恒定，整数总分必然恒定）
  const intervals:{from:number;to:number;sample:StateSample}[]=[];
  for(let i=0;i<xs.length-1;i++){
    const lo=xs[i],hi=xs[i+1];
    if(hi-lo<EPS)continue;
    const s=sampleState(options,path,(lo+hi)/2);
    evaluations++;
    if(s)intervals.push({from:lo,to:hi,sample:s});
  }
  // 合并相邻同状态区间
  const segments:StateSegment[]=[];
  for(const iv of intervals){
    const last=segments[segments.length-1];
    if(last&&stateKey(last.state)===stateKey(iv.sample.state)&&Math.abs(last.to-iv.from)<1e-6){
      last.to=iv.to;
    }else{
      segments.push({from:iv.from,to:iv.to,state:iv.sample.state,ranked:iv.sample.ranked});
    }
  }
  // 候选点状态；与左右相邻（合并前）区间都不同的为孤立点（必须显示，不能并进某一段）
  const points:PointState[]=[];
  for(let idx=0;idx<xs.length;idx++){
    const x=xs[idx];
    const s=pointSamples.get(x);
    if(!s)continue;
    const left=intervals[idx-1]?.sample;
    const right=intervals[idx]?.sample;
    const dl=!left||stateKey(left.state)!==stateKey(s.state);
    const dr=!right||stateKey(right.state)!==stateKey(s.state);
    // 端点 0/100 只在轴端标注；内点与两侧都不同才是需要单独显示的孤立状态
    if(dl&&dr&&x>EPS&&x<100-EPS)points.push({x,state:s.state,ranked:s.ranked,isolated:true});
  }
  // 转折：相邻分段状态变化；若折点位置存在孤立状态，在转折中携带该精确点状态
  const allTransitions:Transition[]=[];
  for(let i=0;i<segments.length-1;i++){
    const g=segments[i],h=segments[i+1];
    const isolated=points.find(p=>Math.abs(p.x-g.to)<1e-6);
    allTransitions.push({at:g.to,from:g.state,to:h.state,point:isolated?.state});
  }
  // 显示分带：折叠舍入微抖动；分带之间的切换为“主要转折”，带内保留“精确微切换”
  const{bands,microCuts}=buildDisplayBands(segments);
  const microSet=new Set(microCuts.map(c=>c.at));
  const transitions=allTransitions.filter(t=>!microSet.has(t.at));
  const keys=new Set(segments.map(g=>stateKey(g.state)));
  points.forEach(p=>keys.add(stateKey(p.state)));
  return{target,mode,segments,points,transitions,bands,microCuts,evaluations,unchanged:keys.size<=1&&points.length===0};
}

// ---------------------------------------------------------------------------
// 方法 A / B：仅用于对比与测试，真实名次同样逐点调用评分函数，不做插值。
// ---------------------------------------------------------------------------

export interface SweepFinding{from:number;to:number;state:RankingState}

/** 方法 A：固定步长扫描。返回按步长观察到的状态带；窄于一个步长的区间会被遗漏。 */
export function fixedStepSweep(
  options:DecisionOption[],
  b:ValueWeights,
  target:ValueKey,
  mode:ReallocationMode,
  step:number
):{bands:SweepFinding[];evaluations:number}{
  const path=createWeightPath(b,target,mode);
  const bands:SweepFinding[]=[];
  let evaluations=0;
  let prev:{x:number;key:string;state:RankingState}|null=null;
  for(let x=0;x<=100+EPS;x+=step){
    const xx=Math.min(100,Math.round(x*1e9)/1e9);
    const s=sampleState(options,path,xx);
    evaluations++;
    if(!s)continue;
    if(!prev){
      bands.push({from:xx,to:xx,state:s.state});
    }else if(prev.key===stateKey(s.state)){
      bands[bands.length-1].to=xx;
    }else{
      bands.push({from:xx,to:xx,state:s.state});
    }
    prev={x:xx,key:stateKey(s.state),state:s.state};
  }
  return{bands,evaluations};
}

/**
 * 方法 B：粗步长扫描 + 仅在“两端状态不同”的格子内二分细化。
 * 定位已发现转折更省，但被粗格整格跨过的窄区间永远不会被检查（盲区由 coarseStep 决定）。
 */
export function adaptiveSweep(
  options:DecisionOption[],
  b:ValueWeights,
  target:ValueKey,
  mode:ReallocationMode,
  coarseStep:number,
  tolerance=0.05
):{bands:SweepFinding[];evaluations:number}{
  const path=createWeightPath(b,target,mode);
  const evaluations={n:0};
  const evalAt=(x:number)=>{evaluations.n++;return sampleState(options,path,x)};
  const grid:number[]=[];
  for(let x=0;x<100-EPS;x+=coarseStep)grid.push(Math.min(100,x));
  grid.push(100);
  const samples=grid.map(x=>({x,s:evalAt(x)}));
  const cuts=new Set<number>([0,100]);
  for(let i=0;i<samples.length-1;i++){
    const a=samples[i],c=samples[i+1];
    if(a.s&&c.s&&stateKey(a.s.state)!==stateKey(c.s.state)){
      // 格内二分，把转折位置压到 tolerance 以内
      let lo=a.x,hi=c.x;
      let loState=stateKey(a.s.state);
      while(hi-lo>tolerance){
        const mid=(lo+hi)/2;
        const ms=evalAt(mid);
        if(ms&&stateKey(ms.state)!==loState)hi=mid;
        else lo=mid;
      }
      cuts.add(Math.round((lo+hi)/2*1e6)/1e6);
    }
  }
  const bounds=[...cuts].sort((p,q)=>p-q);
  const bands:SweepFinding[]=[];
  for(const cut of bounds){
    const s=sampleState(options,path,cut); // 展示用取样（计入评估次数以便如实对比）
    evaluations.n++;
    if(!s)continue;
    const last=bands[bands.length-1];
    if(last&&stateKey(last.state)===stateKey(s.state))last.to=cut;
    else bands.push({from:cut,to:cut,state:s.state});
  }
  return{bands,evaluations:evaluations.n};
}

// ---------------------------------------------------------------------------
// 试探：任意位置按同一规则真实计算，用于并排对比；不触碰草稿权重。
// ---------------------------------------------------------------------------

export interface TrialResult{weights:ValueWeights;ranked:OptionAnalysis[];recommendation:string;winnerId?:string}

export function trialAt(options:DecisionOption[],path:WeightPath,x:number):TrialResult|null{
  const normalized=tryNormalize(path.weightsAt(x));
  if(!normalized)return null;
  const ranked=rankOptions(options,normalized);
  const{recommendation,winnerId}=recommendationFor(ranked);
  return{weights:normalized,ranked,recommendation,winnerId};
}
