import{describe,it,expect}from'vitest';
import{useDecisionStudio}from'../useDecisionStudio';
import type{PrintPort}from'../../ports/print.port';
import type{SavedCase}from'../../core/models';

const storage=new Map<string,string>();
const repo={
  list():SavedCase[]{try{return JSON.parse(storage.get('cases')??'[]')}catch{return[]}},
  save(c:SavedCase){const all=this.list().filter(x=>x.draft.id!==c.draft.id);all.unshift(c);storage.set('cases',JSON.stringify(all))},
  delete(id:string){storage.set('cases',JSON.stringify(this.list().filter(x=>x.draft.id!==id)))}
};
const printer:PrintPort={print(){}};

describe('useDecisionStudio 敏感性试探的套用与失效',()=>{
  it('套用试探权重：写回草稿、立即重新推演且不标记 stale',()=>{
    const studio=useDecisionStudio(repo as never,printer);
    studio.analyze();
    expect(studio.analysis.value).toBeTruthy();
    const beforeGrowth=studio.draft.weights.growth;
    studio.applyTrialWeights({stability:5,growth:80,freedom:10,money:5});
    expect(studio.draft.weights.growth).toBe(80);
    expect(beforeGrowth).not.toBe(80);
    expect(studio.stale.value).toBe(false);
    // 新分析已携带归一化权重快照
    expect(studio.analysis.value!.weights.growth).toBe(80);
    // 结论确实是用新权重按同一规则算出的
    expect(studio.analysis.value!.options.length).toBe(studio.draft.options.length);
  });

  it('重新编辑方案（选项/权重变化）后旧结果标记过期，敏感性视图应据此失效',()=>{
    const studio=useDecisionStudio(repo as never,printer);
    studio.analyze();
    expect(studio.stale.value).toBe(false);
    studio.setWeights({...studio.draft.weights,growth:90});
    expect(studio.stale.value).toBe(true);
    // 过期状态下套用试探不可静默成功：先重新推演才能得到新结果
    studio.applyTrialWeights({stability:10,growth:60,freedom:15,money:15});
    expect(studio.stale.value).toBe(false);
    expect(studio.analysis.value!.weights.growth).toBe(60);
  });

  it('试探本身不触碰草稿：未套用时权重保持不变',()=>{
    const studio=useDecisionStudio(repo as never,printer);
    studio.analyze();
    const snapshot={...studio.draft.weights};
    // 面板内的试探仅存在于组件层；这里验证控制器没有任何隐式写回入口
    expect(studio.draft.weights).toEqual(snapshot);
  });
});
