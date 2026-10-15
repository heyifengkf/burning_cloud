// 火烧云算法可调参数
//
// 所有阈值集中在此处，与算法逻辑（afterglow.js）分离，便于按站点 / 季节校准。
// 默认值经场景回归验证；改动任一数字前建议先跑一遍场景表确认分级仍合理。
//
// 单位约定：云量类输入为 0~1 小数；湿度 %；能见度 km；降水 mm；温度/露点差 °C。

const CFG = {
  // ---- 第一层：门控（乘性硬约束，任一项为 0 则整体归零）----
  gate: {
    precipNow: { soft: 0.95, x0: 0.0, x1: 0.5 },     // 当前降水率 mm/h
    precipPrev: { soft: 0.50, x0: 0.0, x1: 2.0 },    // 过去 1 小时降水 mm（雨后转晴只做弱惩罚）
    lowCloud: { soft: 0.95, x0: 0.30, x1: 0.70 },    // 太阳方位扇区低云
    overcast: { soft: 0.85, x0: 0.70, x1: 0.90 },    // 不透明云量 = 低云 + midCloudWeight×中云
    midCloudWeight: 0.60,
    vis: { floor: 0.30, x0: 5, x1: 20 },             // 能见度 km
    dew: { soft: 0.60, x0: 0.5, x1: 3.0 }            // 露点差 °C
  },

  // ---- 第二层：画布（钟形响应：太少没东西可烧，太多糊成灰）----
  canvas: {
    high: { w: 0.45, mu: 0.40, sigma: 0.28 },
    mid: { w: 0.30, mu: 0.30, sigma: 0.22 },
    low: { w: 0.10, mu: 0.10, sigma: 0.15 },
    total: { w: 0.15, mu: 0.50, sigma: 0.28 }
  },

  // ---- 第二层：辅助评分 ----
  aux: { visX0: 10, visX1: 40, humX0: 70, humX1: 95, trendGain: 2.0, trendBase: 0.5 },
  // 画布是主导因子；权重调高后「云量过少」的个例不再被能见度/湿度抬高
  base: { canvas: 0.70, vis: 0.12, hum: 0.06, trend: 0.08, wind: 0.04 },

  // ---- 第三层：概率校准（Platt scaling: P = σ(k·(Score − θ))）----
  // θ 取 0.55：使「晴空 / 云量过少」落在 20% 以下（θ=0.45 时会给出约 45% 的虚高概率）
  prob: { k: 7.0, theta: 0.55 },

  // ---- 强度模型 ----
  tau: { base: 0.10, high: 0.25, mid: 1.20, low: 5.00 },   // 光学厚度代理
  thick: { mu: 0.90, sigmaLow: 0.45, sigmaHigh: 1.50 },    // 非对称钟形：适中厚度最艳
  lit: { x0: 0.05, x1: 0.70, refDeclineDeg: 2.0 },         // 被照亮云量 → 评分；参考太阳下沉角
  color: { visWeight: 0.60, visX0: 8, visX1: 35, humWeight: 0.40, humX0: 55, humX1: 95 },
  // covFloor/covRef：只有覆盖足够大的云层才能持续发光，避免一缕卷云就拿满时长分
  dur: { x0: 5, x1: 30, covFloor: 0.35, covRef: 0.50 },
  intensity: { thick: 0.30, lit: 0.30, color: 0.25, dur: 0.15 },  // 加权几何平均的指数

  layerZ: { high: 10, mid: 4, low: 1.5 },   // 各层代表高度 km
  perceptible: 0.05                        // 云量低于此值视为「看不见」，不参与时长计算
};

// 概率分级（自上而下匹配，取第一个 min ≤ P 的档位）
const PROB_LEVELS = [
  { min: 0.80, label: '极可能出现' },
  { min: 0.60, label: '很可能' },
  { min: 0.40, label: '有可能' },
  { min: 0.20, label: '概率较低' },
  { min: -1, label: '基本不会' }
];

// 燃烧程度分级（0~5）
const INTENSITY_LEVELS = [
  { min: 4.5, level: 5, label: '爆烧' },
  { min: 3.5, level: 4, label: '强烈' },
  { min: 2.5, level: 3, label: '明显' },
  { min: 1.5, level: 2, label: '一般' },
  { min: 0.5, level: 1, label: '微弱' },
  { min: -1, level: 0, label: '无霞' }
];

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// 递归合并：只覆盖显式给出的字段，其余保留 base 的值。
// 注意 base 中的数组按叶子处理（整体替换，不做逐项合并）。
function extend(base, overrides) {
  const ov = isPlainObject(overrides) ? overrides : null;
  const out = {};
  Object.keys(base).forEach(k => {
    const b = base[k];
    if (isPlainObject(b)) {
      out[k] = extend(b, ov ? ov[k] : null);
    } else {
      out[k] = ov && Object.prototype.hasOwnProperty.call(ov, k) ? ov[k] : b;
    }
  });
  // 允许新增 base 里没有的键（例如站点专属字段）
  if (ov) {
    Object.keys(ov).forEach(k => {
      if (!Object.prototype.hasOwnProperty.call(base, k)) out[k] = ov[k];
    });
  }
  return out;
}

// 生成一份按站点校准的配置，例如：
//   siteConfig({ prob: { theta: 0.52 }, canvas: { high: { mu: 0.45 } } })
// 只写需要改的字段，其余继承默认值。
function siteConfig(overrides) {
  return extend(CFG, overrides || {});
}

module.exports = { CFG, PROB_LEVELS, INTENSITY_LEVELS, extend, siteConfig };
