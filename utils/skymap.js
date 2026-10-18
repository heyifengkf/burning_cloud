// 光线路径云图几何：以观测点为原点，沿太阳方位角（光线来向）向外布置采样网格。
// 只覆盖「光线经过 + 地点上空」的走廊，不做大范围/全国渲染。

const RAD = Math.PI / 180;

// 沿路径的距离环（km），相邻两环之间的横向区间构成一个云量格子
const RINGS_KM = [0, 8, 16, 26, 38, 52, 68, 86];
// 每环的横向采样位置（-1~1，乘以该距离处的半宽）
const LATERAL_FRACS = [-1, -2 / 3, -1 / 3, 0, 1 / 3, 2 / 3, 1];
// 走廊半宽：距离越远越宽（光线发散）
const MIN_HALF_WIDTH_KM = 5;
const HALF_WIDTH_RATIO = 0.3;

const LAYER_COLORS = {
  low: [91, 155, 213],
  mid: [155, 123, 213],
  high: [232, 240, 250]
};

const MAX_KM = RINGS_KM[RINGS_KM.length - 1];

function normLon(lon) {
  return ((lon + 540) % 360) - 180;
}

// 球面正算：从 (lat, lon) 沿 bearing（正北起顺时针，度）走 distKm
function destination(lat, lon, bearingDeg, distKm) {
  const d = distKm / 6371;
  const br = bearingDeg * RAD;
  const lat1 = lat * RAD;
  const lon1 = lon * RAD;
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(br)
  );
  const lon2 = lon1 + Math.atan2(
    Math.sin(br) * Math.sin(d) * Math.cos(lat1),
    Math.cos(d) - Math.sin(lat1) * Math.sin(lat2)
  );
  return { latitude: lat2 / RAD, longitude: normLon(lon2 / RAD) };
}

function halfWidthKm(d) {
  return Math.max(MIN_HALF_WIDTH_KM, d * HALF_WIDTH_RATIO);
}

// 生成采样点与格子。
// points[i] = { latitude, longitude }；cells[n].corners 为格子四角在 points 中的下标
// （第 0 环塌缩到观测点，故最内圈格子是三边形）。
function buildLightPath(lat, lon, bearingDeg) {
  const bearing = Number.isFinite(bearingDeg) ? bearingDeg : 0;
  const points = [];
  const rings = [];

  RINGS_KM.forEach(d => {
    const row = [];
    if (d === 0) {
      points.push(destination(lat, lon, bearing, 0));
      const idx = points.length - 1;
      LATERAL_FRACS.forEach(() => row.push(idx));
    } else {
      const hw = halfWidthKm(d);
      LATERAL_FRACS.forEach(f => {
        const lateral = f * hw;
        const dist = Math.sqrt(d * d + lateral * lateral);
        const brg = bearing + Math.atan2(lateral, d) / RAD;
        points.push(destination(lat, lon, brg, dist));
        row.push(points.length - 1);
      });
    }
    rings.push(row);
  });

  const cells = [];
  for (let r = 0; r < RINGS_KM.length - 1; r++) {
    for (let s = 0; s < LATERAL_FRACS.length - 1; s++) {
      const quad = [rings[r][s], rings[r][s + 1], rings[r + 1][s + 1], rings[r + 1][s]];
      // 内侧塌缩的点会重复出现，去重后成为三角形
      const corners = quad.filter((v, i) => quad.indexOf(v) === i);
      cells.push({ ring: r, seg: s, corners });
    }
  }

  return { points, cells, ringsKm: RINGS_KM.slice(), bearing, center: { latitude: lat, longitude: lon } };
}

// 地图初始视野中心：走廊中段
function corridorCenter(lat, lon, bearingDeg) {
  return destination(lat, lon, bearingDeg, MAX_KM * 0.45);
}

// 云量 0~1 → map 组件可用的 8 位十六进制颜色；低于 5% 视为无云
function cloudColor(v, layer) {
  if (!(v >= 0.05)) return '';
  const c = LAYER_COLORS[layer] || LAYER_COLORS.low;
  const a = Math.round(Math.min(0.82, 0.10 + v * 0.72) * 255);
  return '#' + c.map(x => x.toString(16).padStart(2, '0')).join('')
    + a.toString(16).padStart(2, '0');
}

// 图例渐变：无云 → 满云
function legendGradient(layer) {
  const c = LAYER_COLORS[layer] || LAYER_COLORS.low;
  const solid = `rgb(${c[0]},${c[1]},${c[2]})`;
  const soft = `rgba(${c[0]},${c[1]},${c[2]},0.08)`;
  return `linear-gradient(90deg, ${soft}, ${solid})`;
}

module.exports = {
  RINGS_KM,
  LATERAL_FRACS,
  MAX_KM,
  destination,
  halfWidthKm,
  buildLightPath,
  corridorCenter,
  cloudColor,
  legendGradient
};
