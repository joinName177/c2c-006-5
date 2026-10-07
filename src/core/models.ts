export const VALUE_KEYS=['stability','growth','freedom','money'] as const;
export type ValueKey=typeof VALUE_KEYS[number];
export type ValueWeights=Record<ValueKey,number>;
export interface DecisionOption{id:string;name:string;description:string;impacts:ValueWeights;reversibility:number}
export interface DecisionDraft{id:string;title:string;background:string;options:DecisionOption[];weights:ValueWeights;updatedAt:string}
export type Horizon=1|5|10;
export interface RegretPoint{horizon:Horizon;score:number;breakdown:ValueWeights}
export interface RehearsalCard{horizon:Horizon;regret:string;trigger:string;reversibility:string;action:string}
export interface OptionAnalysis{option:DecisionOption;points:RegretPoint[];cards:RehearsalCard[];total:number}
export interface DecisionAnalysis{options:OptionAnalysis[];recommendation:string;winnerId?:string;notices:string[]}
export interface SavedCase{draft:DecisionDraft;analysis?:DecisionAnalysis}
export const VALUE_LABELS:Record<ValueKey,string>={stability:'稳定',growth:'成长',freedom:'自由',money:'金钱'};
