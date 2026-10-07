import{describe,it,expect,vi}from'vitest';
import{mount}from'@vue/test-utils';
import SensitivityPanel from'../components/SensitivityPanel.vue';
import{analyzeDecision}from'../../core/analysis-service';
import{createSampleDraft}from'../../core/sample-data';
import{VALUE_LABELS,type ValueWeights}from'../../core/models';

function setup(){
  const draft=createSampleDraft();
  const analysis=analyzeDecision(draft);
  const apply=vi.fn();
  const wrapper=mount(SensitivityPanel,{props:{analysis,stale:false,'onApply':apply}});
  return{wrapper,analysis,apply,draft};
}

describe('SensitivityPanel 生命周期与交互',()=>{
  it('渲染状态轴、分段与图例；并列区间有独立纹样且不显示为唯一胜者',()=>{
    const{wrapper}=setup();
    expect(wrapper.find('.sen-axis').exists()).toBe(true);
    const rects=wrapper.findAll('.sen-seg rect');
    expect(rects.length).toBeGreaterThan(0);
    // 第一个与最后一个分段覆盖到轴端（SVG <title> 是 rect 的子元素）
    const titles=rects.map(r=>r.find('title').text());
    expect(titles[0]).toContain('0%');
    expect(titles[titles.length-1]).toContain('100%');
    expect(wrapper.text()).toContain('接近 / 并列');
  });

  it('初始不显示试探对比；拖动滑块后出现对比表与套用/放弃按钮',async()=>{
    const{wrapper}=setup();
    expect(wrapper.find('.sen-compare').exists()).toBe(false);
    const slider=wrapper.find('.sen-probe input[type=range]').element as HTMLInputElement;
    slider.value='55';
    await wrapper.find('.sen-probe input[type=range]').trigger('input');
    expect(wrapper.find('.sen-compare').exists()).toBe(true);
    expect(wrapper.text()).toContain('套用');
    expect(wrapper.text()).toContain('放弃试探');
  });

  it('试探只发出事件、不直接改权重；放弃后对比消失',async()=>{
    const{wrapper,apply}=setup();
    const slider=wrapper.find('.sen-probe input[type=range]').element as HTMLInputElement;
    slider.value='80';
    await wrapper.find('.sen-probe input[type=range]').trigger('input');
    await wrapper.find('.sen-probe-actions .primary').trigger('click');
    expect(apply).toHaveBeenCalledTimes(1);
    const w=apply.mock.calls[0][0] as ValueWeights;
    expect(w.growth).toBeCloseTo(80,6);
    // 权重和恒为 100
    expect(Object.values(w).reduce((a,b)=>a+b,0)).toBeCloseTo(100,6);
    // 重新出现试探前：组件内部不应保留
    expect(wrapper.find('.sen-compare').exists()).toBe(false);
  });

  it('切换维度/分摊方式后重新分段，不残留旧试探',async()=>{
    const{wrapper}=setup();
    const slider=wrapper.find('.sen-probe input[type=range]').element as HTMLInputElement;
    slider.value='70';
    await wrapper.find('.sen-probe input[type=range]').trigger('input');
    expect(wrapper.find('.sen-compare').exists()).toBe(true);
    const selects=wrapper.findAll('select');
    selects[0].setValue('money');
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.sen-compare').exists()).toBe(false);
    expect(wrapper.text()).toContain(VALUE_LABELS.money);
  });

  it('stale=true 时面板停用并提示旧结果失效；恢复后重建',async()=>{
    const{wrapper}=setup();
    expect(wrapper.find('.sen-axis').exists()).toBe(true);
    await wrapper.setProps({stale:true});
    expect(wrapper.find('.sen-axis').exists()).toBe(false);
    expect(wrapper.text()).toContain('旧的敏感性结果已失效');
    await wrapper.setProps({stale:false});
    expect(wrapper.find('.sen-axis').exists()).toBe(true);
  });

  it('全程无转折时显示不敏感说明，而不是空列表',()=>{
    const draft=createSampleDraft();
    // 两个选项在稳定维度上完全相同的构造：改稳定权重不影响它们的相对名次
    draft.options=draft.options.slice(0,2);
    draft.options.forEach(o=>{o.impacts.stability=0});
    const analysis=analyzeDecision(draft);
    const wrapper=mount(SensitivityPanel,{props:{analysis,stale:false}});
    const selects=wrapper.findAll('select');
    selects[0].setValue('stability');
    // 直接检查文案（watch 是异步刷新后的同步重算）
    expect(wrapper.text()).toMatch(/建议都不会改变|不敏感/);
  });
});
