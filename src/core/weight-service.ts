import{VALUE_KEYS,type ValueWeights}from'./models';
export const PRESETS:Record<string,ValueWeights>={均衡考虑:{stability:25,growth:25,freedom:25,money:25},稳健优先:{stability:45,growth:15,freedom:15,money:25},成长优先:{stability:15,growth:50,freedom:20,money:15},自由优先:{stability:15,growth:20,freedom:50,money:15}};
export function normalizeWeights(weights:ValueWeights):ValueWeights{const sum=VALUE_KEYS.reduce((n,k)=>n+Math.max(0,weights[k]),0);if(!sum)throw new Error('请至少关注一个价值维度');return Object.fromEntries(VALUE_KEYS.map(k=>[k,Math.round(Math.max(0,weights[k])/sum*1000)/10]))as ValueWeights}
