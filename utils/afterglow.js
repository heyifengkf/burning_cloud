// 朝霞 / 晚霞评估算法
//
// 结构：
//   1) 门控（乘性硬约束）—— 光路被挡则整体归零
//   2) 画布软评分（钟形响应）—— 云量适中才好看
//   3) 概率校准（Platt scaling）
//   4) 强度模型（光学厚度代理 + 照亮范围 + 成色 + 持续时长）
//
// 所有阈值集中在 ./config.js，与逻辑分离，便于按站点/地形校准；
// evaluate() 接受可选的第二参数传入校准后的配置，缺省用默认配置。
// 云量类输入统一为 0~1 的小数，湿度/能见度用常用单位（%、km、mm）。

const solar = require('./solar.js');
const { CFG: DEFAULT_CFG, PROB_LEVELS, INTENSITY_LEVELS } = require('./config.js');

const clamp = (x, a, b) => Math.min(Math.max(x, a), b);
const ramp = (x, x0, x1) => clamp((x - x0) / (x1 - x0), 0, 1);
const fall = (x, x0, x1) => 1 - ramp(x, x0, x1);
const bell = (x, mu, sigma) => Math.exp(-Math.pow((x - mu) / sigma, 2));
const bellAsym = (x, mu, sigLow, sigHigh) => {
  const s = x < mu ? sigLow : sigHigh;
  return Math.exp(-Math.pow((x - mu) / s, 2));
};

function pickLevel(levels, value, key) {
  for (let i = 0; i < levels.length; i++) {
    if (value >= levels[i][key]) return levels[i];
  }
  return levels[levels.length - 1];
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// 门控：光路是否通畅
function gates(inp, cfg) {
  const g = cfg.gate;
  const opaque = inp.cloudLow + g.midCloudWeight * inp.cloudMid;

  const precip = (1 - g.precipNow.soft * ramp(inp.precipNow, g.precipNow.x0, g.precipNow.x1))
    * (1 - g.precipPrev.soft * ramp(inp.precipPrev, g.precipPrev.x0, g.precipPrev.x1));
  const lowCloud = 1 - g.lowCloud.soft * ramp(inp.cloudLow, g.lowCloud.x0, g.lowCloud.x1);
  const overcast = 1 - g.overcast.soft * ramp(opaque, g.overcast.x0, g.overcast.x1);
  const vis = g.vis.floor + (1 - g.vis.floor) * ramp(inp.visKm, g.vis.x0, g.vis.x1);
  const dew = 1 - g.dew.soft * fall(inp.spreadC, g.dew.x0, g.dew.x1);

  return {
    precip,
    lowCloud,
    overcast,
    vis,
    dew,
    all: precip * lowCloud * overcast * vis * dew,
    opaque
  };
}

// 画布软评分 + 辅助评分
function softScores(inp, cfg) {
  const c = cfg.canvas;
  const canvas = c.high.w * bell(inp.cloudHigh, c.high.mu, c.high.sigma)
    + c.mid.w * bell(inp.cloudMid, c.mid.mu, c.mid.sigma)
    + c.low.w * bell(inp.cloudLow, c.low.mu, c.low.sigma)
    + c.total.w * bell(inp.cloudTotal, c.total.mu, c.total.sigma);

  const a = cfg.aux;
  const vis = ramp(inp.visKm, a.visX0, a.visX1);
  const hum = 1 - 0.50 * ramp(inp.rhPct, a.humX0, a.humX1);
  const trend = clamp(a.trendBase - a.trendGain * inp.deltaCloudTotal, 0, 1);
  const wind = 0.50 + 0.50 * Math.cos((inp.windDirDeg + 180 - inp.sunAzimuthDeg) * Math.PI / 180);

  const w = cfg.base;
  const base = w.canvas * canvas + w.vis * vis + w.hum * hum + w.trend * trend + w.wind * wind;

  return { canvas, vis, hum, trend, wind, base: clamp(base, 0, 1) };
}

// 强度：光学厚度代理 / 照亮范围 / 成色 / 时长
function intensityModel(inp, cfg) {
  const t = cfg.tau;
  const tau = t.base + t.high * inp.cloudHigh + t.mid * inp.cloudMid + t.low * inp.cloudLow;
  const thick = bellAsym(tau, cfg.thick.mu, cfg.thick.sigmaLow, cfg.thick.sigmaHigh);

  // 太阳下沉到参考角（默认 2°）时，仍能被照亮的最低云底高度
  const zMin = solar.litAltitudeKm(-cfg.lit.refDeclineDeg);
  const zH = cfg.layerZ.high;
  const zM = cfg.layerZ.mid;
  const zL = cfg.layerZ.low;
  const litHigh = zH >= zMin ? inp.cloudHigh : 0;
  const litMid = zM >= zMin ? inp.cloudMid : 0;
  const litLow = zL >= zMin ? inp.cloudLow : 0;
  // 各层云量是「同一片天空被该层覆盖的比例」，彼此重叠，不能相加（会超过 100%）。
  // 按独立事件取并集，得到被照亮云的真实天空覆盖比例，恒 ≤ 1。
  const cloudLit = 1 - (1 - litHigh) * (1 - litMid) * (1 - litLow);
  const lit = ramp(cloudLit, cfg.lit.x0, cfg.lit.x1);

  const cw = cfg.color;
  const color = cw.visWeight * ramp(inp.visKm, cw.visX0, cw.visX1)
    + cw.humWeight * (1 - ramp(inp.rhPct, cw.humX0, cw.humX1));

  // 最高一层「可察觉」云层决定霞光能持续多久，并按该层覆盖率打折
  let zTop = 0;
  let cTop = 0;
  const consider = (cover, z) => {
    if (cover >= cfg.perceptible && z > zTop) { zTop = z; cTop = cover; }
  };
  consider(inp.cloudLow, zL);
  consider(inp.cloudMid, zM);
  consider(inp.cloudHigh, zH);

  const glowMin = zTop > 0 ? solar.glowDurationMin(zTop) : 0;
  const covFactor = zTop > 0
    ? cfg.dur.covFloor + (1 - cfg.dur.covFloor) * clamp(cTop / cfg.dur.covRef, 0, 1)
    : 0;
  const dur = ramp(glowMin, cfg.dur.x0, cfg.dur.x1) * covFactor;

  const e = cfg.intensity;
  const raw = 5 * Math.pow(thick, e.thick) * Math.pow(lit, e.lit)
    * Math.pow(color, e.color) * Math.pow(dur, e.dur);

  return {
    tau,
    thick,
    lit,
    color,
    dur,
    glowMin,
    zMin,
    zTop,
    cTop,
    cloudLit,
    raw: clamp(raw, 0, 5)
  };
}

// 主入口：单次日出/日落事件评估
// inp: {
//   cloudTotal, cloudHigh, cloudMid, cloudLow,   // 0~1
//   rhPct, spreadC, visKm, precipNow, precipPrev,
//   windDirDeg, sunAzimuthDeg, deltaCloudTotal
// }
// cfg: 可选，由 config.siteConfig({...}) 生成的校准配置；缺省用默认配置。
function evaluate(inp, cfg) {
  const c = cfg || DEFAULT_CFG;
  const g = gates(inp, c);
  const s = softScores(inp, c);
  const model = intensityModel(inp, c);

  const score = clamp(g.all * s.base, 0, 1);
  const pc = c.prob;
  const prob = clamp(1 / (1 + Math.exp(-pc.k * (score - pc.theta))), 0, 1);

  const intensity = clamp(g.all * model.raw, 0, 5);
  const probLevel = pickLevel(PROB_LEVELS, prob, 'min');
  const intLevel = pickLevel(INTENSITY_LEVELS, intensity, 'min');

  return {
    score,
    prob,
    probPct: Math.round(prob * 100),
    probLevel: probLevel.label,
    intensity,
    intensityRaw: model.raw,
    intensityLevel: intLevel.level,
    intensityLabel: intLevel.label,
    detail: {
      gates: g,
      soft: s,
      model
    }
  };
}

module.exports = {
  CFG: DEFAULT_CFG,
  PROB_LEVELS,
  INTENSITY_LEVELS,
  evaluate,
  gates,
  softScores,
  intensityModel,
  clamp,
  ramp,
  fall,
  bell,
  bellAsym,
  num
};
