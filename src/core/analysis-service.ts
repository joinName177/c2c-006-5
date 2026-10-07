import{rankOptions,recommendationFor}from'./scoring';
import{normalizeWeights}from'./weight-service';
import type{DecisionAnalysis,DecisionDraft}from'./models';

export function safetyNoticesFor(text:string):string[]{
  const notices:string[]=[];
  if(/医疗|诊断|治疗|medical/i.test(text))notices.push('涉及医疗，请同时咨询合格医疗专业人士。');
  if(/法律|诉讼|合同|legal/i.test(text))notices.push('涉及法律，请同时咨询合格法律专业人士。');
  if(/投资|股票|理财|investment/i.test(text))notices.push('涉及投资，请评估承受能力并咨询持牌专业人士。');
  return notices;
}

/** 正式推演：归一化 → 同一套评分规则排序 → 沿用现有建议文案；快照归一化权重供敏感性试探使用。 */
export function analyzeDecision(draft:DecisionDraft):DecisionAnalysis{
  const weights=normalizeWeights(draft.weights);
  const ranked=rankOptions(draft.options,weights);
  const{recommendation,winnerId}=recommendationFor(ranked);
  return{
    options:ranked,
    recommendation,
    winnerId,
    notices:safetyNoticesFor(`${draft.title} ${draft.background}`),
    weights
  };
}
