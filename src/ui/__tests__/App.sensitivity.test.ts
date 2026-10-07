import{describe,it,expect,beforeEach}from'vitest';
import{mount}from'@vue/test-utils';
import App from'../App.vue';

beforeEach(()=>localStorage.clear());

describe('App 集成：结果页敏感性试探',()=>{
  it('推演后结果页含敏感性面板，能切换维度并完成试探套用',async()=>{
    const wrapper=mount(App,{attachTo:document.body});
    // 生成预演
    wrapper.find('button.primary').trigger('click');
    await wrapper.vm.$nextTick();await wrapper.vm.$nextTick();
    const panel=wrapper.findComponent({name:'SensitivityPanel'});
    expect(panel.exists()).toBe(true);
    // 轴与转折/图例渲染
    expect(panel.find('.sen-axis').exists()).toBe(true);
    expect(panel.findAll('.sen-seg rect').length).toBeGreaterThan(0);
    // 切换分摊方式：由一个维度承担
    const selects=panel.findAll('select');
    selects[1].setValue('locked');
    await panel.vm.$nextTick();
    expect(panel.findAll('select').length).toBe(3);
    // 拖动试探滑块到 90%
    const slider=panel.find('.sen-probe input[type=range]');
    (slider.element as HTMLInputElement).value='90';
    slider.trigger('input');
    await panel.vm.$nextTick();
    expect(panel.find('.sen-compare').exists()).toBe(true);
    // 点击套用：权重写回草稿并按同一规则立即重新推演
    await panel.find('.sen-probe-actions .primary').trigger('click');
    await wrapper.vm.$nextTick();await wrapper.vm.$nextTick();
    // 套用后已用新权重重算（归一化 growth≈90）
    expect(wrapper.findComponent({name:'SensitivityPanel'}).props('analysis').weights.growth).toBeGreaterThan(85);
    wrapper.unmount();
  },15000);

  it('切回录入页修改权重后，结果页敏感性面板提示失效；重新推演后恢复',async()=>{
    const wrapper=mount(App,{attachTo:document.body});
    wrapper.find('button.primary').trigger('click');
    await wrapper.vm.$nextTick();await wrapper.vm.$nextTick();
    // 通过顶部导航回到录入页，改第一个滑块
    const navButtons=wrapper.findAll('header nav button');
    navButtons[0].trigger('click');
    await wrapper.vm.$nextTick();
    const sliders=wrapper.findAll('.values input[type=range]');
    (sliders[0].element as HTMLInputElement).value='80';
    sliders[0].trigger('input');
    await wrapper.vm.$nextTick();
    // 回到结果页
    navButtons[1].trigger('click');
    await wrapper.vm.$nextTick();
    const panel=wrapper.findComponent({name:'SensitivityPanel'});
    expect(panel.text()).toContain('旧的敏感性结果已失效');
    // 重新推演
    wrapper.find('header .actions .primary').trigger('click');
    await wrapper.vm.$nextTick();await wrapper.vm.$nextTick();
    expect(wrapper.findComponent({name:'SensitivityPanel'}).find('.sen-axis').exists()).toBe(true);
    wrapper.unmount();
  },15000);
});
