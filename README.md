# c2c-006 · 决策后悔模拟器

Vue 3 + TypeScript + Vite 纯前端决策反思工具。支持录入 2–4 个方案、设置稳定/成长/自由/金钱权重、生成 1/5/10 年后悔指数与预演卡，并以 SVG 曲线比较“最不后悔”方向。

## 架构

- `src/core`：领域模型、输入校验、权重归一化、后悔评分、预演与安全提示
- `src/ports`：案例仓储和打印端口
- `src/adapters`：localStorage 与浏览器打印实现
- `src/ui`：Vue 控制器、分步组件和原生 CSS

## 运行

```bash
npm install
npm run dev
npm run build
docker compose up --build
```

Docker 部署访问 `http://localhost:8106`。案例仅保存在当前浏览器。

指数是透明、确定性的本地规则：分别计算 1、5、10 年价值偏差和可逆性成本，再按 30% / 40% / 30% 合成总分。它不预测真实未来，也不替代医疗、法律或投资专业意见。
