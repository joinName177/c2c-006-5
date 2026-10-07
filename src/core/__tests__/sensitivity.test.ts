import{describe,it,expect}from'vitest';
import{normalizeWeights}from'../weight-service';
import type{DecisionOption,ValueWeights}from'../models';
import{
  createWeightPath,analyzeSensitivity,fixedStepSweep,adaptiveSweep,trialAt,sampleState,stateKey,
  type ReallocationMode
}from'../sensitivity';
import{analyzeDecision}from'../analysis-service';
import type{DecisionDraft}from'../models';

const opt=(id:string,name:string,impacts:ValueWeights,reversibility=100):DecisionOption=>({id,name,description:'',impacts,reversibility});
const all=(s:number,g:number,f:number,m:number):ValueWeights=>({stability:s,growth:g,freedom:f,money:m});

const baseWeights=normalizeWeights(all(30,35,20,15));

describe('权重路径：增加一个维度时其余权重的分摊',()=>{
  const modes:ReallocationMode[]=[{kind:'proportional'},{kind:'equal'},{kind:'locked',bearer:'money'}];
  it.each(modes)('任意位置非负且和为 100（%j）',mode=>{
    const path=createWeightPath(baseWeights,'growth',mode);
    for(let x=0;x<=100;x+=3.7){
      const w=path.weightsAt(x);
      Object.values(w).forEach(v=>expect(v).toBeGreaterThanOrEqual(-1e-9));
      const sum=Object.values(w).reduce((a,b)=>a+b,0);
      expect(sum).toBeCloseTo(100,9);
      expect(w.growth).toBeCloseTo(x,9);
    }
  });
  it('proportional：其余维度保持彼此相对比例',()=>{
    const path=createWeightPath(baseWeights,'growth','proportional' as unknown as ReallocationMode);
    // 显式构造
    const p=createWeightPath(baseWeights,'growth',{kind:'proportional'});
    const w=p.weightsAt(60);
    expect(w.stability/w.freedom).toBeCloseTo(baseWeights.stability/baseWeights.freedom,9);
    expect(w.stability+w.freedom+w.money).toBeCloseTo(40,9);
  });
  it('proportional 退化：当前权重 100% 时其余维度按均摊处理',()=>{
    const b=normalizeWeights(all(0,100,0,0));
    const w=createWeightPath(b,'growth',{kind:'proportional'}).weightsAt(40);
    expect(w.growth).toBe(40);
    expect(w.stability).toBeCloseTo(20,10);
    expect(w.stability+w.freedom+w.money).toBeCloseTo(60,10);
  });
  it('locked：承担维度先被压到 0，剩余需求由其余维度按比例承担',()=>{
    // growth 35→80 需让出 45；money(15) 先全让，仍缺 30 由 stability/freedom 按 30:20 分
    const w=createWeightPath(baseWeights,'growth',{kind:'locked',bearer:'money'}).weightsAt(80);
    expect(w.money).toBe(0);
    expect(w.stability).toBeCloseTo(30-30*30/50,6);
    expect(w.freedom).toBeCloseTo(20-30*20/50,6);
    const sum=Object.values(w).reduce((a,c)=>a+c,0);
    expect(sum).toBeCloseTo(100,9);
  });
  it('locked：降低目标维度时由承担维度独自吸收',()=>{
    const w=createWeightPath(baseWeights,'growth',{kind:'locked',bearer:'money'}).weightsAt(10);
    expect(w.money).toBeCloseTo(40,9);
    expect(w.stability).toBe(30);
    expect(w.freedom).toBe(20);
  });
  it('端点：0% 完全不看该维度，100% 只看该维度（不会全零）',()=>{
    const path=createWeightPath(baseWeights,'growth',{kind:'proportional'});
    const z=path.weightsAt(0);expect(z.growth).toBe(0);
    expect(z.stability+z.freedom+z.money).toBeCloseTo(100,9);
    const h=path.weightsAt(100);
    expect(h.growth).toBe(100);
    expect(h.stability+h.freedom+h.money).toBeCloseTo(0,9);
  });
});

describe('结构枚举：无遗漏分段',()=>{
  it('分段覆盖整个 [0,100]，首段从 0 起、末段到 100 结束',()=>{
    const options=[opt('a','甲',all(5,5,5,5)),opt('b','乙',all(-5,-5,-5,-5))];
    const r=analyzeSensitivity(options,baseWeights,'growth',{kind:'proportional'});
    expect(r.segments[0].from).toBe(0);
    expect(r.segments[r.segments.length-1].to).toBe(100);
    let cover=0;
    r.segments.forEach(g=>{cover+=g.to-g.from});
    expect(cover).toBeCloseTo(100,6);
  });
  it('每个分段内部与密集网格真实计算的名次一致（不用插值）',()=>{
    const options=[
      opt('a','甲',all(4,-1,0,2),75),
      opt('b','乙',all(-2,5,2,3),55),
      opt('c','丙',all(2,3,1,1),85)
    ];
    for(const mode of[{kind:'proportional'},{kind:'equal'},{kind:'locked',bearer:'money'}]as ReallocationMode[]){
      for(const target of['stability','growth','freedom','money']as const){
        const r=analyzeSensitivity(options,baseWeights,target,mode);
        const path=createWeightPath(baseWeights,target,mode);
        // 偏移网格，避免恰好落在 0.1 折点上
        for(let x=0.013;x<100;x+=0.371){
          const seg=r.segments.find(g=>x>=g.from-1e-6&&x<=g.to+1e-6)!;
          expect(seg).toBeTruthy();
          const s=sampleState(options,path,x)!;
          expect(stateKey(s.state)).toBe(stateKey(seg.state));
        }
      }
    }
  });
  it('转折位置与独立细网格交叉验证',()=>{
    const options=[opt('a','甲',all(0,5,0,0)),opt('b','乙',all(0,-5,0,0))];
    const b=normalizeWeights(all(0,25,0,75));
    const r=analyzeSensitivity(options,b,'growth',{kind:'locked',bearer:'money'});
    const path=createWeightPath(b,'growth',{kind:'locked',bearer:'money'});
    expect(r.transitions.length).toBeGreaterThan(0);
    for(const t of r.transitions){
      const before=sampleState(options,path,t.at-0.02)!;
      const after=sampleState(options,path,t.at+0.02)!;
      expect(stateKey(before.state)).toBe(stateKey(t.from));
      expect(stateKey(after.state)).toBe(stateKey(t.to));
    }
  });
});

describe('窄并列区间：固定步长与粗扫细化会遗漏，结构枚举命中',()=>{
  // 甲在成长上 +5（不受成长权重影响），乙在成长上 -5，其余维度无差异。
  // x=0 两者同为 0 分（并列），乙总分约以 1.135/x 上升，约 4.4% 后差距≥5，并列带贴在轴端且很窄。
  const boundary=[opt('a','甲',all(5,5,5,5)),opt('b','乙',all(5,-5,5,5))];
  const bb=normalizeWeights(all(10,80,5,5));
  it('结构法找到贴在 0 端、宽度约 4 个百分点的窄并列带',()=>{
    const r=analyzeSensitivity(boundary,bb,'growth',{kind:'proportional'});
    const tieSegments=r.segments.filter(g=>g.state.kind==='tie');
    expect(tieSegments.length).toBeGreaterThan(0);
    const width=tieSegments[0].to-tieSegments[0].from;
    expect(tieSegments[0].from).toBe(0);
    expect(width).toBeGreaterThan(3);
    expect(width).toBeLessThan(5);
  });
  it('固定步长 5% 扫描观测不到完整轴端并列带（只在 x=0 点碰到，宽度为 0）',()=>{
    const{bands}=fixedStepSweep(boundary,bb,'growth',{kind:'proportional'},5);
    const positive=bands.filter(z=>z.state.kind==='tie'&&z.to-z.from>0);
    expect(positive.length).toBe(0);
  });
  it('步长 1% 可以观测到并列带，但定位只精确到步长量级',()=>{
    const{bands}=fixedStepSweep(boundary,bb,'growth',{kind:'proportional'},1);
    const tie=bands.filter(z=>z.state.kind==='tie'&&z.to-z.from>0);
    expect(tie.length).toBeGreaterThan(0);
  });

  // 内部窄区间（解析构造）：30/40/30 时间加权后四维度的时间系数加权都为 1.0。
  // locked 路径、money 承担、x*=17 处触 0；成长系数 dg=−0.5（甲 impact −2、乙 3），
  // 金钱系数 dm=1（甲 −5、乙 5）。触 0 前后分差斜率从 +0.5 翻为 −0.5，分差在 x* 附近
  // 形成浅 V：格子两端 x=10、20 都是乙唯一领先（差 8、6 分），中间仅约 16.6–17.6
  // 这 1 个百分点内短暂进入差距 <5 的并列；步长 5%/10% 的两端状态相同，逐步细化永不触发。
  const interior=[opt('a','甲',all(2,-2,0,-5)),opt('b','乙',all(-2,3,0,5))];
  const bi=normalizeWeights(all(10,12,73,5)); // g0+m0=17=x*
  const iMode:ReallocationMode={kind:'locked',bearer:'money'};
  it('结构法命中内部窄并列带（约 16.6–17.6），带内为并列、格子两端为同一唯一胜者',()=>{
    const r=analyzeSensitivity(interior,bi,'growth',iMode);
    const ties=r.segments.filter(g=>g.state.kind==='tie'&&g.from>15&&g.to<19);
    expect(ties.length).toBeGreaterThan(0);
    const lo=Math.min(...ties.map(g=>g.from));
    const hi=Math.max(...ties.map(g=>g.to));
    expect(lo).toBeGreaterThan(15.5);
    expect(hi).toBeLessThan(19);
    expect(hi-lo).toBeLessThan(2);
    const path=createWeightPath(bi,'growth',iMode);
    // 带内确有真实并列；格子两端为同一明确胜者
    const inside=sampleState(interior,path,17)!;
    expect(inside.state.kind).toBe('tie');
    for(const x of[10,20]){
      const s=sampleState(interior,path,x)!;
      expect(s.state.kind).toBe('winner');
      expect((s.state as{optionId:string}).optionId).toBe('b');
    }
  });
  it('固定步长 5% 扫描完全观测不到该并列带（21 次评估）',()=>{
    const{bands,evaluations}=fixedStepSweep(interior,bi,'growth',iMode,5);
    expect(bands.some(z=>z.state.kind==='tie')).toBe(false);
    expect(evaluations).toBe(21);
  });
  it('固定步长 10% 同样遗漏（11 次评估）——步长加大直接扩大盲区',()=>{
    const{bands,evaluations}=fixedStepSweep(interior,bi,'growth',iMode,10);
    expect(bands.some(z=>z.state.kind==='tie')).toBe(false);
    expect(evaluations).toBe(11);
  });
  it('粗扫 5%/10% + 逐步细化同样遗漏：格子两端状态相同，加密永不触发',()=>{
    expect(adaptiveSweep(interior,bi,'growth',iMode,5,0.02).bands.some(z=>z.state.kind==='tie')).toBe(false);
    expect(adaptiveSweep(interior,bi,'growth',iMode,10,0.05).bands.some(z=>z.state.kind==='tie')).toBe(false);
  });
  it('固定步长 1%（101 次评估）才恰好采到；精度与计算量线性对冲，结构法以远少评估无遗漏',()=>{
    const{bands,evaluations}=fixedStepSweep(interior,bi,'growth',iMode,1);
    expect(bands.some(z=>z.state.kind==='tie')).toBe(true);
    expect(evaluations).toBe(101);
    const r=analyzeSensitivity(interior,bi,'growth',iMode);
    expect(r.evaluations).toBeLessThan(4000);
  });
});

describe('多转折、零权重与极端偏好',()=>{
  const options=[
    opt('a','甲',all(5,5,5,5)),   // 成长系数 0
    opt('c','丙',all(5,0,5,5)),   // 成长系数 0.5
    opt('b','乙',all(5,-5,5,5))   // 成长系数 1
  ];
  const b=normalizeWeights(all(10,80,5,5));
  const r=analyzeSensitivity(options,b,'growth',{kind:'proportional'});
  it('三选项随权重升高产生多个转折（多人并列 → 两人接近 → 唯一胜者）',()=>{
    const keys=r.segments.map(g=>stateKey(g.state));
    expect(new Set(keys).size).toBeGreaterThanOrEqual(3);
    // 起点三人均在接近组
    expect(r.segments[0].state.kind).toBe('tie');
    if(r.segments[0].state.kind==='tie')expect(r.segments[0].state.members).toContain('a');
    // 终点差距充分拉开，甲唯一领先
    const last=r.segments[r.segments.length-1];
    expect(last.state).toEqual({kind:'winner',optionId:'a'});
  });
  it('x=0 零权重与 x=100 极端偏好都有可解释状态',()=>{
    const path=createWeightPath(b,'growth',{kind:'proportional'});
    for(const x of[0,100]){
      const t=trialAt(options,path,x)!;
      expect(t.ranked.length).toBe(3);
      expect(t.weights.growth).toBe(x===100?100:0);
      expect(t.recommendation.length).toBeGreaterThan(0);
    }
  });
  it('某维度全程不改变建议时显式标注 unchanged（支配性选项任何权重组合都领先 ≥5）',()=>{
    // 甲在每个维度都不差于乙、且多数维度显著更好：任何非负权重组合下甲都唯一领先
    const dom=[opt('a','甲',all(5,5,5,5)),opt('b','乙',all(-5,-3,-3,-3))];
    const r=analyzeSensitivity(dom,baseWeights,'stability',{kind:'proportional'});
    expect(r.unchanged).toBe(true);
    expect(r.segments.every(g=>g.state.kind==='winner'&&g.state.optionId==='a')).toBe(true);
  });
});

describe('试探一致性与并列判定边界',()=>{
  const options=[
    opt('a','甲',all(4,-1,0,2),75),
    opt('b','乙',all(-2,5,2,3),55),
    opt('c','丙',all(2,3,1,1),85)
  ];
  it('任意试探位置的总分 = 用该原始权重组重新 analyzeDecision 的总分',()=>{
    const path=createWeightPath(baseWeights,'freedom',{kind:'locked',bearer:'stability'});
    for(const x of[0,7.3,42.6,100]){
      const trial=trialAt(options,path,x)!;
      const draft:DecisionDraft={id:'t',title:'t',background:'',options,weights:path.weightsAt(x),updatedAt:''};
      const full=analyzeDecision(draft);
      for(const row of trial.ranked){
        const ref=full.options.find(o=>o.option.id===row.option.id)!;
        expect(row.total).toBe(ref.total);
      }
      expect(trial.recommendation).toBe(full.recommendation);
    }
  });
  it('并列→唯一胜者的边界：左侧差距 <5，右侧差距恰好为 5（差 5 仍有胜者）',()=>{
    const pair=[opt('a','甲',all(5,5,5,5)),opt('b','乙',all(5,-5,5,5))];
    const b=normalizeWeights(all(0,100,0,0));
    const r=analyzeSensitivity(pair,b,'growth',{kind:'proportional'});
    const t=r.transitions.find(tr=>tr.from.kind==='tie'&&tr.to.kind==='winner')!;
    expect(t).toBeTruthy();
    const leftSeg=r.segments.find(g=>Math.abs(g.to-t.at)<1e-6&&g.state.kind==='tie')!;
    const rightSeg=r.segments.find(g=>Math.abs(g.from-t.at)<1e-6&&g.state.kind==='winner')!;
    const gapOf=(seg:typeof leftSeg)=>seg.ranked[1].total-seg.ranked[0].total;
    expect(gapOf(leftSeg)).toBeLessThan(5);
    expect(gapOf(rightSeg)).toBe(5);
    // 精确边界点按右连续规则取样，给出明确胜者
    const path=createWeightPath(b,'growth',{kind:'proportional'});
    const atBoundary=sampleState(pair,path,t.at)!;
    expect(atBoundary.state.kind).toBe('winner');
  });
});
