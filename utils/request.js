// 网络请求封装：反查地名 + Open-Meteo 数据
// 说明：小程序需在「开发管理 → 服务器域名」把下面两个域名加入 request 合法域名：
//   https://api.open-meteo.com
//   https://nominatim.openstreetmap.org
// 本地调试可在「详情 → 本地设置」勾选「不校验合法域名」。
//
// 选址不再依赖在线正向地理编码：自动定位用 wx.getLocation，
// 手动选址用 wx.chooseLocation（微信自带地图组件，自带搜索与拖动图钉，
// 且直接返回地名，无需域名白名单）。

// ECMWF / GFS 实际提供云量的气压层（顺序即绘图顺序，从近地面到高空）
const LEVELS_HPAS = {
  ec: [1000, 925, 850, 700, 600, 500, 400, 300, 250, 200, 150, 100, 50],
  gfs: [1000, 975, 950, 925, 900, 850, 800, 700, 600, 500, 400, 300, 250, 200, 150, 100, 50]
};

// 数据源 → Open-Meteo 模型名
const API_MODEL = {
  ec: 'ecmwf_ifs025',
  gfs: 'gfs_seamless'
};

// 渲染窗口：从当前整点开始共 72 小时（3 天）
// 用 forecast_hours 而不是 forecast_days，返回的时间序列第一项就是「站点当地时间的当前整点」
const FORECAST_HOURS = 72;

function getJSON(url) {
  return new Promise(resolve => {
    wx.request({
      url,
      success: r => resolve(r && r.statusCode === 200 ? r.data : null),
      fail: err => {
        console.warn('[request] 请求失败（请检查 request 合法域名）', url, err);
        resolve(null);
      }
    });
  });
}

// 经纬度反查地名（与网页版一致用 Nominatim）。失败返回空串，由调用方兜底展示坐标。
const reverseGeocode = async (lat, lon) => {
  const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}` +
    '&format=jsonv2&zoom=10&accept-language=zh&_=' + Date.now();
  const j = await getJSON(url);
  if (j && j.address) {
    const a = j.address;
    return a.city || a.town || a.county || a.district || a.village || a.state || a.country || '';
  }
  return (j && j.name) || '';
};

// 云层剖面数据（气压层云量）+ 地面要素数据
// forecast_hours=72 让服务端直接返回「从当地当前整点开始的 3 天」，
// 因此页面拿到的时间序列就是渲染窗口，不需要再做时区换算。
// model: 'ec' | 'gfs'，两个模式的可用气压层不同，需分别拼接。
const fetchData = async (lat, lon, model = 'ec') => {
  const key = LEVELS_HPAS[model] ? model : 'ec';
  const lvVars = LEVELS_HPAS[key].map(h => `cloud_cover_${h}hPa`).join(',');
  const surf = 'cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high';
  const surfVars = 'temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m,wind_direction_10m,visibility';
  const apiModel = API_MODEL[key];
  const base = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`;
  // 带上时间戳避免命中系统缓存，保证「当前整点」是真正当前的
  const stamp = Date.now();
  const url1 = `${base}&hourly=${surf},${lvVars}&models=${apiModel}&forecast_hours=${FORECAST_HOURS}&timezone=auto&_=${stamp}`;
  const url2 = `${base}&hourly=${surfVars}&forecast_hours=${FORECAST_HOURS}&timezone=auto&_=${stamp}`;

  const [j1, j2] = await Promise.all([getJSON(url1), getJSON(url2)]);
  if (!j1 || !j1.hourly || !j1.hourly.time || !j1.hourly.time.length) {
    console.warn('[request] 云层数据无效', key, j1 && j1.reason);
    return null;
  }
  if (j2 && j2.hourly) j1.hourly_surface = j2.hourly;
  return j1;
};

module.exports = { reverseGeocode, fetchData, LEVELS_HPAS, API_MODEL, FORECAST_HOURS };
