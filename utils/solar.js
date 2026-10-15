// 太阳位置与日出日落计算（NOAA Solar Calculator 简化实现）
// 全部输入输出均不依赖设备时区：时间统一用「站点当地墙钟」的毫秒数表示，
// 由调用方传入 utc_offset_seconds 做换算。

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;
const R_EARTH_KM = 6371;
// 日出/日落定义为日面上缘与地平线相切，含大气折射 + 日面半径
const SUNRISE_ZENITH_DEG = 90.833;
// 大气下沉角变化率（中纬度平均），度/分钟，用于估算霞光持续时长
const D_ALT_DT_DEG_PER_MIN = 0.25;

function clamp(x, a, b) {
  return Math.min(Math.max(x, a), b);
}

function norm360(x) {
  const r = x % 360;
  return r < 0 ? r + 360 : r;
}

function julianDay(ms) {
  return ms / 86400000 + 2440587.5;
}

// 赤纬（度）与时差（分钟）
function solarParams(ms) {
  const T = (julianDay(ms) - 2451545.0) / 36525;
  const L0 = norm360(280.46646 + T * (36000.76983 + T * 0.0003032));
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);

  const C = Math.sin(M * RAD) * (1.914602 - T * (0.004817 + 0.000014 * T))
    + Math.sin(2 * M * RAD) * (0.019993 - 0.000101 * T)
    + Math.sin(3 * M * RAD) * 0.000289;
  const trueLong = L0 + C;

  const omega = 125.04 - 1934.136 * T;
  const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(omega * RAD);

  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * RAD);

  const decl = Math.asin(Math.sin(eps * RAD) * Math.sin(lambda * RAD)) * DEG;

  const y = Math.pow(Math.tan(eps * RAD / 2), 2);
  const eqTime = 4 * DEG * (
    y * Math.sin(2 * L0 * RAD)
    - 2 * e * Math.sin(M * RAD)
    + 4 * e * y * Math.sin(M * RAD) * Math.cos(2 * L0 * RAD)
    - 0.5 * y * y * Math.sin(4 * L0 * RAD)
    - 1.25 * e * e * Math.sin(2 * M * RAD)
  );

  return { decl, eqTime };
}

// 某「站点当地日期」（YYYY-MM-DD）的日出/日落时刻（当地墙钟毫秒）
function sunEventsForDate(localDateStr, lat, lon, tzOffsetSec) {
  const utcNoonMs = Date.parse(localDateStr + 'T12:00:00Z') - tzOffsetSec * 1000;
  const d = new Date(utcNoonMs);
  const dayStartUtc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const p = solarParams(dayStartUtc + 12 * 3600000);

  const cosZenith = Math.cos(SUNRISE_ZENITH_DEG * RAD);
  const rawCosH = cosZenith / (Math.cos(lat * RAD) * Math.cos(p.decl * RAD))
    - Math.tan(lat * RAD) * Math.tan(p.decl * RAD);
  // |rawCosH| > 1 → 该日极昼（< -1）或极夜（> 1），无日出日落
  if (rawCosH > 1 || rawCosH < -1) {
    return { polar: true, polarDay: rawCosH < -1, riseWallMs: NaN, setWallMs: NaN };
  }

  const H = Math.acos(clamp(rawCosH, -1, 1)) * DEG;
  const solarNoonMin = 720 - 4 * lon - p.eqTime;
  const toWall = min => dayStartUtc + min * 60000 + tzOffsetSec * 1000;

  return {
    polar: false,
    riseWallMs: toWall(solarNoonMin - 4 * H),
    setWallMs: toWall(solarNoonMin + 4 * H)
  };
}

// 指定时刻的太阳方位角（正北起顺时针，度）与高度角（度）
function sunPosition(utcMs, lat, lon) {
  const p = solarParams(utcMs);
  const d = new Date(utcMs);
  const minutesUtc = d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60 + d.getUTCMilliseconds() / 60000;
  const trueSolarTime = ((minutesUtc + p.eqTime + 4 * lon) % 1440 + 1440) % 1440;
  const H = trueSolarTime / 4 - 180;

  const sinEl = Math.sin(lat * RAD) * Math.sin(p.decl * RAD)
    + Math.cos(lat * RAD) * Math.cos(p.decl * RAD) * Math.cos(H * RAD);
  const elevation = Math.asin(clamp(sinEl, -1, 1)) * DEG;

  const azimuth = norm360(
    Math.atan2(
      Math.sin(H * RAD),
      Math.cos(H * RAD) * Math.sin(lat * RAD) - Math.tan(p.decl * RAD) * Math.cos(lat * RAD)
    ) * DEG + 180
  );

  return { elevation, azimuth, declination: p.decl };
}

// 太阳位于给定高度角时，仍能被照亮的云底最低高度（km）
function litAltitudeKm(sunElevationDeg) {
  const d = Math.max(0, -sunElevationDeg) * RAD;
  const c = Math.cos(Math.min(d, Math.PI / 2 - 1e-6));
  return R_EARTH_KM * (1 / c - 1);
}

// 高度 z(km) 的云在日落时的地平线角（度）
function horizonAngleDeg(zKm) {
  return Math.acos(clamp(R_EARTH_KM / (R_EARTH_KM + zKm), -1, 1)) * DEG;
}

// 估算某高度云层的可见霞光时长（分钟）
function glowDurationMin(zKm) {
  return 2 * horizonAngleDeg(zKm) / D_ALT_DT_DEG_PER_MIN;
}

// 当地墙钟（毫秒）→ "HH:MM"
function formatWallTime(wallMs) {
  const d = new Date(wallMs);
  return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
}

// 当地墙钟（毫秒）→ "YYYY-MM-DD"（用于按日遍历）
function wallDateStr(wallMs) {
  const d = new Date(wallMs);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

module.exports = {
  solarParams,
  sunEventsForDate,
  sunPosition,
  litAltitudeKm,
  horizonAngleDeg,
  glowDurationMin,
  formatWallTime,
  wallDateStr,
  R_EARTH_KM
};
