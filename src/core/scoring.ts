import{normalizeWeights}from'./weight-service';
import{HORIZONS,VALUE_KEYS,type DecisionOption,type Horizon,type OptionAnalysis,type RegretPoint,type RehearsalCard,type ValueWeights}from'./models';
import{VALUE_LABELS}from'./models';

/** 时间口径：1/5/10 年三档，短期重稳定金钱，长期重成长自由。 */
export const timeFactor:Record<Horizon,Record<keyof ValueWeights,number>>={
  1:{stability:1.2,growth:.75,freedom:.8,money:1.15},
  5:{stability:1,growth:1,freedom:1,money:1},
  10:{stability:.8,growth:1.25,freedom:1.2,money:.85}
};

export type NormalizedWeights=ValueWeights;

/** 单个时间点的后悔指数（正式推演与敏感性试探共用此唯一实现）。 */
export function scorePoint(option:DecisionOption,weights:NormalizedWeights,horizon:Horizon):RegretPoint{
  const breakdown={}as RegretPoint['breakdown'];
  let total=0;
  for(const key of VALUE_KEYS){
    const negative=(5-option.impacts[key])/10;
    const value=negative*weights[key]*timeFactor[horizon][key];
    breakdown[key]=Math.round(value*10)/10;
    total+=value;
  }
  const irreversible=(100-option.reversibility)*.08*(horizon/10);
  return{horizon,score:Math.max(0,Math.min(100,Math.round(total+irreversible))),breakdown};
}

/** 预演卡沿用现有维度化模板。 */
export function buildCard(option:DecisionOption,p:RegretPoint,weights:NormalizedWeights):RehearsalCard{
  const key=VALUE_KEYS.slice().sort((a,b)=>weights[b]*(5-option.impacts[b])-weights[a]*(5-option.impacts[a]))[0];
  const label=VALUE_LABELS[key];
  return{
    horizon:p.horizon,
    regret:`${p.horizon} 年后，你可能遗憾「${option.name}」没有更好照顾${label}。`,
    trigger:`当${label}需求持续得不到满足，后悔感可能升高。`,
    reversibility:option.reversibility>=60?'仍有较大调整空间':'改变成本可能随时间增加',
    action:`现在就为${label}设一个可检查的阶段目标。`
  };
}

/** 总分：1 年 30%、5 年 40%、10 年 30%，四舍五入；按总分升序返回。 */
export function rankOptions(options:DecisionOption[],weights:NormalizedWeights):OptionAnalysis[]{
  return options.map(option=>{
    const points=HORIZONS.map(h=>scorePoint(option,weights,h));
    return{
      option,
      points,
      cards:points.map(p=>buildCard(option,p,weights)),
      total:Math.round(points[0].score*.3+points[1].score*.4+points[2].score*.3)
    };
  }).sort((a,b)=>a.total-b.total);
}

/** 前两名差距 <5 为接近（差距恰好 5 仍有明确胜者）。 */
export function isCloseRanking(ranked:OptionAnalysis[]):boolean{
  return Boolean(ranked[1]&&ranked[1].total-ranked[0].total<5);
}

/** 建议文案与胜者判定，正式推演与试探对比共用同一份措辞规则。 */
export function recommendationFor(ranked:OptionAnalysis[]):{recommendation:string;winnerId?:string}{
  if(isCloseRanking(ranked)){
    return{recommendation:`「${ranked[0].option.name}」与「${ranked[1].option.name}」非常接近，建议补充信息后再决定。`};
  }
  return{recommendation:`目前看，「${ranked[0].option.name}」是更不容易后悔的方向。`,winnerId:ranked[0].option.id};
}

/** 给定任意原始权重向量，返回归一化权重；全零返回 null（不抛异常，供试探路径复用）。 */
export function tryNormalize(raw:ValueWeights):NormalizedWeights|null{
  try{return normalizeWeights(raw)}catch{return null}
}
