/* 微信小程序 → 浏览器预览运行时
 * 负责：WXML 指令渲染（wx:if/wx:for/{{}}）、wx API 模拟、页面生命周期、
 *       canvas 复用、map 组件的近似渲染。
 */
(function () {
  'use strict';

  // ================= 基础工具 =================

  const clone = v => (v == null ? v : JSON.parse(JSON.stringify(v)));

  function setByPath(obj, path, value) {
    if (!/[.[]/.test(path)) { obj[path] = value; return; }
    const segs = path.replace(/\[(\d+)\]/g, '.$1').split('.');
    let cur = obj;
    for (let i = 0; i < segs.length - 1; i++) {
      const k = segs[i];
      if (cur[k] == null) cur[k] = /^\d+$/.test(segs[i + 1]) ? [] : {};
      cur = cur[k];
    }
    cur[segs[segs.length - 1]] = value;
  }

  function camelCase(s) {
    return String(s).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  }

  function datasetOf(el) {
    const out = {};
    if (el && el.dataset) {
      Object.keys(el.dataset).forEach(k => { out[k] = el.dataset[k]; });
    }
    return out;
  }

  // ================= 表达式求值 =================

  const exprCache = new Map();

  function evalExpr(expr, scope) {
    if (expr == null) return undefined;
    const key = String(expr);
    let fn = exprCache.get(key);
    if (!fn) {
      try {
        fn = new Function('$s', 'with ($s) { return (' + key + '); }');
      } catch (e) {
        console.warn('[预览] 表达式语法错误:', key, e.message);
        fn = () => undefined;
      }
      exprCache.set(key, fn);
    }
    try {
      return fn(scope);
    } catch (e) {
      return undefined;
    }
  }

  function interp(str, scope) {
    if (typeof str !== 'string' || str.indexOf('{{') < 0) return str;
    return str.replace(/\{\{([\s\S]*?)\}\}/g, (_, e) => {
      const v = evalExpr(e, scope);
      return v == null ? '' : String(v);
    });
  }

  // 整个属性就是一个 {{表达式}} 时保留原始类型（数组 / 布尔 / 数字）
  function evalAttr(raw, scope) {
    if (typeof raw !== 'string') return raw;
    const m = raw.match(/^\s*\{\{([\s\S]*)\}\}\s*$/);
    if (m) return evalExpr(m[1], scope);
    return interp(raw, scope);
  }

  // ================= WXML 渲染 =================

  const TAG_MAP = {
    view: 'div',
    text: 'span',
    block: null,
    image: 'img',
    'cover-image': 'img',
    canvas: 'canvas',
    map: 'wx-map',
    button: 'button',
    navigator: 'span',
    'scroll-view': 'div',
    swiper: 'div',
    'swiper-item': 'div',
    picker: 'div',
    input: 'input',
    textarea: 'textarea',
    switch: 'span',
    slider: 'div',
    icon: 'span',
    label: 'label',
    form: 'form'
  };

  const EVENT_MAP = {
    tap: 'click',
    longpress: 'contextmenu',
    touchstart: 'pointerdown',
    touchmove: 'pointermove',
    touchend: 'pointerup',
    touchcancel: 'pointercancel',
    input: 'input',
    change: 'change',
    confirm: 'keydown',
    scroll: 'scroll'
  };

  const POINTER_TYPES = { pointerdown: 1, pointermove: 1, pointerup: 1, pointercancel: 1 };

  function makeEvent(domEv, el, type) {
    const dataset = datasetOf(el);
    const touches = [];
    if (domEv.touches && domEv.touches.length) {
      for (let i = 0; i < domEv.touches.length; i++) {
        const t = domEv.touches[i];
        touches.push({ clientX: t.clientX, clientY: t.clientY, pageX: t.pageX, pageY: t.pageY, identifier: t.identifier });
      }
    } else if (domEv.clientX !== undefined) {
      touches.push({ clientX: domEv.clientX, clientY: domEv.clientY, pageX: domEv.pageX, pageY: domEv.pageY });
    }
    const detail = {};
    if (domEv.detail !== undefined && domEv.detail !== null) detail.value = domEv.detail.value;
    if (el && 'value' in el && (type === 'input' || type === 'change')) detail.value = el.value;
    return {
      type,
      timeStamp: Date.now(),
      currentTarget: { id: el.id || '', dataset },
      target: { id: el.id || '', dataset },
      detail,
      touches,
      changedTouches: touches,
      preventDefault() {},
      stopPropagation() {}
    };
  }

  const ACTIVE = {
    page: null,
    host: null
  };

  function renderTree(ast, data, host, persistent) {
    const pending = [];
    const frag = document.createDocumentFragment();
    renderChildren((ast && ast.children) || [], data, frag, persistent, pending);

    while (host.firstChild) host.removeChild(host.firstChild);
    host.appendChild(frag);

    pending.forEach(item => {
      if (item.el.__wxUpdate) {
        try {
          item.el.__wxUpdate(item.props);
        } catch (e) {
          console.error('[预览] 组件更新失败', e);
        }
      }
    });
  }

  function appendText(node, scope, parent) {
    const text = interp(node.v, scope);
    if (!text) return;
    parent.appendChild(document.createTextNode(text));
  }

  function renderChildren(children, scope, parent, persistent, pending) {
    let chainActive = false;
    let chainSatisfied = false;

    for (let i = 0; i < children.length; i++) {
      const node = children[i];
      if (node.t === 'txt') { appendText(node, scope, parent); continue; }
      if (node.t !== 'el') continue;

      const attrs = node.attrs || {};

      if ('wx:if' in attrs) {
        chainActive = true;
        chainSatisfied = !!evalExpr(attrs['wx:if'].replace(/^\{\{|\}\}$/g, ''), scope);
        if (chainSatisfied) renderElement(node, scope, parent, persistent, pending);
        continue;
      }
      if ('wx:elif' in attrs) {
        if (chainActive && !chainSatisfied) {
          chainSatisfied = !!evalExpr(attrs['wx:elif'].replace(/^\{\{|\}\}$/g, ''), scope);
          if (chainSatisfied) renderElement(node, scope, parent, persistent, pending);
        }
        continue;
      }
      if ('wx:else' in attrs) {
        if (chainActive && !chainSatisfied) renderElement(node, scope, parent, persistent, pending);
        chainActive = false;
        continue;
      }

      chainActive = false;
      renderElement(node, scope, parent, persistent, pending);
    }
  }

  function renderElement(node, scope, parent, persistent, pending) {
    const attrs = node.attrs || {};
    if ('wx:for' in attrs) {
      const list = evalExpr(attrs['wx:for'].replace(/^\{\{|\}\}$/g, ''), scope);
      const itemName = attrs['wx:for-item'] || 'item';
      const indexName = attrs['wx:for-index'] || 'index';
      const arr = Array.isArray(list) ? list : [];
      arr.forEach((item, i) => {
        const child = Object.create(scope);
        child[itemName] = item;
        child[indexName] = i;
        renderOne(node, child, parent, persistent, pending);
      });
      return;
    }
    renderOne(node, scope, parent, persistent, pending);
  }

  function createElementFor(tag, attrs, scope) {
    switch (tag) {
      case 'block':
        return null;
      case 'map':
        return document.createElement('div');
      case 'canvas':
        return document.createElement('canvas');
      default: {
        const mapped = TAG_MAP[tag];
        return document.createElement(mapped || 'div');
      }
    }
  }

  function renderOne(node, scope, parent, persistent, pending) {
    const tag = node.tag;
    const attrs = node.attrs || {};
    const id = attrs.id ? String(evalAttr(attrs.id, scope)) : '';

    let el = null;
    if (tag === 'map') el = reuseOrCreate(persistent, id, () => {
      const box = document.createElement('div');
      box.className = 'wx-map';
      return box;
    });
    else if (tag === 'canvas') el = reuseOrCreate(persistent, id, () => document.createElement('canvas'));
    else el = createElementFor(tag, attrs, scope);

    if (!el) { // block
      renderChildren(node.children || [], scope, parent, persistent, pending);
      return;
    }

    if (tag === 'map' || tag === 'canvas') {
      if (id) persistent.set(tag + ':' + id, el);
      el.setAttribute('data-wx-tag', tag);
    }

    applyAttrs(el, tag, attrs, scope, pending);

    if (node.children && node.children.length && tag !== 'canvas' && tag !== 'map') {
      renderChildren(node.children, scope, el, persistent, pending);
    }

    parent.appendChild(el);
  }

  function reuseOrCreate(persistent, id, factory) {
    if (id && persistent) {
      const key = id;
      for (const [k, v] of persistent) {
        if (k.endsWith(':' + key)) { persistent.delete(k); return v; }
      }
    }
    return factory();
  }

  function applyAttrs(el, tag, attrs, scope, pending) {
    const props = {};
    let hasProp = false;

    Object.keys(attrs).forEach(name => {
      const raw = attrs[name];

      if (name.startsWith('wx:')) return;
      if (name === 'wx:key') return;

      // 事件
      const evMatch = name.match(/^(capture-)?(bind|catch):?([a-zA-Z]+)$/);
      if (evMatch) {
        bindEvent(el, evMatch[2], evMatch[3], raw);
        return;
      }

      if (name === 'class') {
        const val = interp(raw, scope);
        if (val) el.className = (el.className ? el.className + ' ' : '') + val;
        return;
      }
      if (name === 'style') { el.setAttribute('style', interp(raw, scope)); return; }
      if (name === 'id') { el.id = interp(raw, scope); return; }
      if (name === 'src' && tag === 'image') { el.setAttribute('src', interp(raw, scope)); return; }

      if (name.startsWith('data-')) {
        el.dataset[camelCase(name.slice(5))] = interp(raw, scope);
        return;
      }

      const value = evalAttr(raw, scope);
      if (tag === 'map') {
        props[name] = value;
        hasProp = true;
        return;
      }
      if (value === false || value == null) return;
      el.setAttribute(name, String(value));
    });

    if (tag === 'map') {
      ensurePreviewMap(el);
      pending.push({ el, props: hasProp ? props : {} });
    }
  }

  function bindEvent(el, bindKind, wtype, handler) {
    const domType = EVENT_MAP[wtype] || wtype;
    const name = String(handler).trim();
    if (!name) return;

    el.addEventListener(domType, domEv => {
      const page = ACTIVE.page;
      const fn = page && page[name];
      if (typeof fn !== 'function') {
        console.warn('[预览] 未找到事件处理函数:', name);
        return;
      }
      if (POINTER_TYPES[domType] && el.setPointerCapture && domEv.pointerId != null) {
        try { el.setPointerCapture(domEv.pointerId); } catch (e) {}
      }
      if (domType === 'contextmenu') domEv.preventDefault();
      try {
        fn(makeEvent(domEv, el, wtype));
      } catch (e) {
        console.error('[预览] 事件 ' + name + ' 执行出错', e);
      }
    });
  }

  // ================= map 组件（近似渲染） =================

  const TILE_URL = (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
  const tileCache = new Map();

  function hexToRgba(color, alphaFallback) {
    if (!color) return 'rgba(0,0,0,0)';
    const m = String(color).trim().match(/^#([0-9a-f]{3,8})$/i);
    if (!m) return color;
    let hex = m[1];
    if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
    if (hex.length === 6) return `rgba(${parseInt(hex.slice(0, 2), 16)},${parseInt(hex.slice(2, 4), 16)},${parseInt(hex.slice(4, 6), 16)},${alphaFallback == null ? 1 : alphaFallback})`;
    return `rgba(${parseInt(hex.slice(0, 2), 16)},${parseInt(hex.slice(2, 4), 16)},${parseInt(hex.slice(4, 6), 16)},${Math.round(parseInt(hex.slice(6, 8), 16) / 255 * 100) / 100})`;
  }

  function project(lat, lon, zoom) {
    const size = 256 * Math.pow(2, zoom);
    const s = Math.min(0.9999, Math.max(-0.9999, Math.sin(lat * Math.PI / 180)));
    return {
      x: (lon + 180) / 360 * size,
      y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * size
    };
  }

  function unproject(x, y, zoom) {
    const size = 256 * Math.pow(2, zoom);
    const n = Math.PI - 2 * Math.PI * y / size;
    return {
      latitude: 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))),
      longitude: x / size * 360 - 180
    };
  }

  function PreviewMap(el) {
    this.el = el;
    this.canvas = document.createElement('canvas');
    this.el.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.props = {};
    this.view = { zoom: 8, center: { latitude: 39.9, longitude: 116.4 } };
    this.fitKey = '';
    this.drag = null;
    this.tiles = new Map();
    this.attrib = document.createElement('div');
    this.attrib.className = 'wx-map-attrib';
    this.attrib.textContent = '© OpenStreetMap · 预览简化底图';
    this.el.appendChild(this.attrib);
    this.bindEvents();
  }

  PreviewMap.prototype.bindEvents = function () {
    const c = this.canvas;
    c.addEventListener('pointerdown', e => {
      this.drag = { x: e.clientX, y: e.clientY };
      try { c.setPointerCapture(e.pointerId); } catch (err) {}
    });
    c.addEventListener('pointermove', e => {
      if (!this.drag) return;
      const dx = e.clientX - this.drag.x;
      const dy = e.clientY - this.drag.y;
      this.drag = { x: e.clientX, y: e.clientY };
      this.panBy(dx, dy);
    });
    const end = () => { this.drag = null; };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('wheel', e => {
      e.preventDefault();
      this.zoomAt(e.offsetX, e.offsetY, e.deltaY < 0 ? 0.35 : -0.35);
    }, { passive: false });
    c.addEventListener('dblclick', e => this.zoomAt(e.offsetX, e.offsetY, 1));
  };

  PreviewMap.prototype.size = function () {
    const w = this.el.clientWidth || 320;
    const h = this.el.clientHeight || 240;
    return { w, h };
  };

  PreviewMap.prototype.resize = function (w, h) {
    const dpr = window.devicePixelRatio || 1;
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw;
      this.canvas.height = ph;
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  PreviewMap.prototype.update = function (props) {
    this.props = props || {};
    const points = (this.props.includePoints || []).filter(
      p => p && isFinite(p.latitude) && isFinite(p.longitude)
    );
    const key = points.length ? points.map(p => p.latitude.toFixed(4) + ',' + p.longitude.toFixed(4)).join(';') : '';
    if (key && key !== this.fitKey) {
      this.fitKey = key;
      this.fit(points);
    } else if (!key && this.props.center) {
      this.view.center = {
        latitude: Number(this.props.center.latitude) || this.view.center.latitude,
        longitude: Number(this.props.center.longitude) || this.view.center.longitude
      };
      if (this.props.scale) this.view.zoom = Number(this.props.scale) + 1;
    }
    this.draw();
  };

  PreviewMap.prototype.fit = function (points) {
    if (!points.length) return;
    const { w, h } = this.size();
    const pad = 24;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    points.forEach(p => {
      const q = project(p.latitude, p.longitude, 0);
      minX = Math.min(minX, q.x); maxX = Math.max(maxX, q.x);
      minY = Math.min(minY, q.y); maxY = Math.max(maxY, q.y);
    });
    const bw = Math.max(1e-6, maxX - minX);
    const bh = Math.max(1e-6, maxY - minY);
    const zoom = Math.log2(Math.min((w - pad * 2) / bw, (h - pad * 2) / bh));
    this.view.zoom = Math.max(3, Math.min(17, zoom));
    this.view.center = unproject((minX + maxX) / 2, (minY + maxY) / 2, 0);
  };

  PreviewMap.prototype.panBy = function (dx, dy) {
    const c = project(this.view.center.latitude, this.view.center.longitude, this.view.zoom);
    this.view.center = unproject(c.x - dx, c.y - dy, this.view.zoom);
    this.draw();
  };

  PreviewMap.prototype.zoomAt = function (px, py, delta) {
    const { w, h } = this.size();
    const c = project(this.view.center.latitude, this.view.center.longitude, this.view.zoom);
    const geo = unproject(c.x - w / 2 + px, c.y - h / 2 + py, this.view.zoom);
    this.view.zoom = Math.max(3, Math.min(17, this.view.zoom + delta));
    const c2 = project(geo.latitude, geo.longitude, this.view.zoom);
    this.view.center = unproject(c2.x + w / 2 - px, c2.y + h / 2 - py, this.view.zoom);
    this.draw();
  };

  PreviewMap.prototype.draw = function () {
    const { w, h } = this.size();
    this.resize(w, h);
    const ctx = this.ctx;
    const z = this.view.zoom;
    const center = project(this.view.center.latitude, this.view.center.longitude, z);
    const originX = center.x - w / 2;
    const originY = center.y - h / 2;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#eef1f5';
    ctx.fillRect(0, 0, w, h);

    this.drawTiles(ctx, w, h, originX, originY, z);
    this.drawGraticule(ctx, w, h, originX, originY, z);

    const toPx = p => ({
      x: project(p.latitude, p.longitude, z).x - originX,
      y: project(p.latitude, p.longitude, z).y - originY
    });

    (this.props.circles || []).forEach(c => {
      if (!isFinite(c.latitude) || !isFinite(c.longitude)) return;
      const p = toPx(c);
      const metersPerPx = 156543.03392 * Math.cos(c.latitude * Math.PI / 180) / Math.pow(2, z);
      const r = Math.max(2, (Number(c.radius) || 0) / metersPerPx);
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      if (c.fillColor) { ctx.fillStyle = hexToRgba(c.fillColor); ctx.fill(); }
      if (c.color) {
        ctx.strokeStyle = hexToRgba(c.color);
        ctx.lineWidth = Number(c.strokeWidth) || 1;
        ctx.stroke();
      }
    });

    (this.props.polyline || []).forEach(line => {
      const pts = (line.points || []).map(toPx);
      if (pts.length < 2) return;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.strokeStyle = hexToRgba(line.color || '#000000');
      ctx.lineWidth = Number(line.width) || 2;
      ctx.setLineDash(line.dottedLine ? [6, 4] : []);
      ctx.stroke();
      ctx.setLineDash([]);
      if (line.arrowLine) {
        const a = pts[pts.length - 2];
        const b = pts[pts.length - 1];
        const ang = Math.atan2(b.y - a.y, b.x - a.x);
        const head = Math.max(6, ctx.lineWidth * 4);
        ctx.beginPath();
        ctx.moveTo(b.x, b.y);
        ctx.lineTo(b.x - head * Math.cos(ang - 0.4), b.y - head * Math.sin(ang - 0.4));
        ctx.lineTo(b.x - head * Math.cos(ang + 0.4), b.y - head * Math.sin(ang + 0.4));
        ctx.closePath();
        ctx.fillStyle = hexToRgba(line.color || '#000000');
        ctx.fill();
      }
    });

    (this.props.polygons || []).forEach(poly => {
      const pts = (poly.points || []).map(toPx);
      if (pts.length < 3) return;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.closePath();
      ctx.fillStyle = hexToRgba(poly.fillColor);
      ctx.fill();
      if (poly.strokeWidth) {
        ctx.strokeStyle = hexToRgba(poly.strokeColor || poly.fillColor);
        ctx.lineWidth = Number(poly.strokeWidth);
        ctx.stroke();
      }
    });
  };

  PreviewMap.prototype.drawTiles = function (ctx, w, h, originX, originY, z) {
    if (!WXPreview.showBasemap) return;
    const zoomInt = Math.max(2, Math.min(18, Math.round(z)));
    const scale = Math.pow(2, z - zoomInt);
    const tileSize = 256 * scale;
    const startX = Math.floor(originX / tileSize);
    const startY = Math.floor(originY / tileSize);
    const cols = Math.ceil(w / tileSize) + 1;
    const rows = Math.ceil(h / tileSize) + 1;
    const max = Math.pow(2, zoomInt);

    for (let x = startX; x < startX + cols; x++) {
      for (let y = startY; y < startY + rows; y++) {
        if (y < 0 || y >= max) continue;
        const tx = ((x % max) + max) % max;
        const url = TILE_URL(zoomInt, tx, y);
        const img = this.getTile(url);
        if (img && img.complete && img.naturalWidth) {
          ctx.drawImage(img, x * tileSize - originX, y * tileSize - originY, tileSize + 0.5, tileSize + 0.5);
        }
      }
    }
  };

  PreviewMap.prototype.getTile = function (url) {
    if (this.tiles.has(url)) return this.tiles.get(url);
    const img = new Image();
    img.referrerPolicy = 'no-referrer';
    img.onload = () => { if (this.drawPending !== true) { this.drawPending = true; requestAnimationFrame(() => { this.drawPending = false; this.draw(); }); } };
    img.onerror = () => { this.tiles.set(url, null); };
    img.src = url;
    this.tiles.set(url, img);
    return img;
  };

  PreviewMap.prototype.drawGraticule = function (ctx, w, h, originX, originY, z) {
    if (WXPreview.showBasemap) return;
    ctx.strokeStyle = 'rgba(120,140,165,0.35)';
    ctx.lineWidth = 1;
    ctx.font = '10px sans-serif';
    ctx.fillStyle = '#8899aa';
    const step = z < 6 ? 2 : z < 9 ? 1 : 0.5;
    const tl = unproject(originX, originY, z);
    const br = unproject(originX + w, originY + h, z);
    for (let lon = Math.floor(tl.longitude / step) * step; lon <= br.longitude; lon += step) {
      const p = project(tl.latitude, lon, z);
      const x = p.x - originX;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
      ctx.fillText(lon.toFixed(1) + '°', x + 3, h - 6);
    }
    for (let lat = Math.floor(br.latitude / step) * step; lat <= tl.latitude; lat += step) {
      const p = project(lat, tl.longitude, z);
      const y = p.y - originY;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
      ctx.fillText(lat.toFixed(1) + '°', 4, y - 4);
    }
  };

  function ensurePreviewMap(el) {
    if (!el.__wxMap) {
      el.__wxMap = new PreviewMap(el);
      el.__wxUpdate = props => el.__wxMap.update(props);
    }
    return el.__wxMap;
  }

  // ================= wx API 模拟 =================

  const logListeners = [];
  ['log', 'info', 'warn', 'error'].forEach(level => {
    const original = console[level].bind(console);
    console[level] = function () {
      const args = Array.prototype.slice.call(arguments);
      original.apply(null, args);
      logListeners.forEach(fn => {
        try { fn(level, args); } catch (e) {}
      });
    };
  });

  const DEFAULT_LOCATION = {
    name: '北京',
    latitude: 39.9042,
    longitude: 116.4074
  };

  const wx = {
    request(opts) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30000);
      fetch(opts.url, { signal: ctrl.signal })
        .then(res => res.text().then(text => ({ status: res.status, text })))
        .then(({ status, text }) => {
          clearTimeout(timer);
          let data = text;
          try { data = JSON.parse(text); } catch (e) {}
          if (status >= 200 && status < 300) {
            if (opts.success) opts.success({ statusCode: status, data, header: {} });
          } else if (opts.fail) {
            opts.fail({ errMsg: 'request:fail HTTP ' + status });
          }
          if (opts.complete) opts.complete();
        })
        .catch(err => {
          clearTimeout(timer);
          console.warn('[预览] 请求失败', opts.url, err && err.message);
          if (opts.fail) opts.fail({ errMsg: 'request:fail ' + (err && err.message) });
          if (opts.complete) opts.complete();
        });
    },

    getWindowInfo() {
      return {
        pixelRatio: window.devicePixelRatio || 1,
        windowWidth: WXPreview.frameWidth || 375,
        windowHeight: window.innerHeight,
        screenWidth: WXPreview.frameWidth || 375,
        screenHeight: window.innerHeight
      };
    },

    getSystemInfoSync() {
      return wx.getWindowInfo();
    },

    getLocation(opts) {
      setTimeout(() => {
        if (opts && opts.success) {
          opts.success({
            latitude: WXPreview.location.latitude,
            longitude: WXPreview.location.longitude
          });
        }
      }, 30);
    },

    chooseLocation(opts) {
      WXPreview.hooks.chooseLocation(picked => {
        if (picked) {
          WXPreview.location = { latitude: picked.latitude, longitude: picked.longitude };
          if (opts && opts.success) {
            opts.success({
              latitude: picked.latitude,
              longitude: picked.longitude,
              name: picked.name,
              address: picked.name
            });
          }
        } else if (opts && opts.fail) {
          opts.fail({ errMsg: 'chooseLocation:fail cancel' });
        }
      });
    },

    requirePrivacyAuthorize(opts) {
      if (opts && opts.success) opts.success({});
    },

    showToast(opts) {
      WXPreview.hooks.toast(opts && opts.title);
      if (opts && opts.success) opts.success();
    },

    showModal(opts) {
      WXPreview.hooks.modal(opts && opts.title, opts && opts.content, ok => {
        if (opts && opts.success) opts.success({ confirm: ok, cancel: !ok });
      });
    },

    openSetting(opts) {
      WXPreview.hooks.toast('预览环境不支持 wx.openSetting');
      if (opts && opts.success) opts.success({ authSetting: {} });
    },

    stopPullDownRefresh() {
      if (WXPreview.hooks.stopPull) WXPreview.hooks.stopPull();
    },

    setNavigationBarTitle(opts) {
      WXPreview.hooks.title(opts && opts.title);
    },

    navigateTo(opts) {
      try {
        WXPreview.hooks.navigate(opts && opts.url);
        if (opts && opts.success) opts.success({});
      } catch (e) {
        if (opts && opts.fail) opts.fail({ errMsg: String(e) });
      }
    },

    navigateBack(opts) {
      WXPreview.hooks.back();
      if (opts && opts.success) opts.success({});
    },

    createSelectorQuery() {
      const ops = [];
      const q = {
        in() { return q; },
        select(sel) { ops.push({ sel, fields: null }); return q; },
        selectAll(sel) { ops.push({ sel, fields: null, all: true }); return q; },
        fields(f) { if (ops.length) ops[ops.length - 1].fields = f; return q; },
        boundingClientRect(cb) { if (ops.length) ops[ops.length - 1].rect = cb; return q; },
        exec(cb) {
          setTimeout(() => {
            const host = ACTIVE.host || document;
            const out = ops.map(op => {
              const els = host.querySelectorAll(op.sel);
              if (op.all) return Array.prototype.map.call(els, el => shape(el, op.fields));
              return els.length ? shape(els[0], op.fields) : null;
            });
            if (cb) cb(out);
          }, 0);
        }
      };
      return q;
    },

    createCanvasContext() {
      return {
        draw() {},
        setFillStyle() {}, setStrokeStyle() {}, setFontSize() {},
        fillRect() {}, fillText() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}
      };
    }
  };

  function shape(el, fields) {
    if (!fields) return el;
    const out = {};
    if (fields.node) out.node = el;
    if (fields.id) out.id = el.id;
    if (fields.size || fields.rect) {
      out.width = el.clientWidth;
      out.height = el.clientHeight;
      out.left = el.offsetLeft;
      out.top = el.offsetTop;
    }
    return out;
  }

  // ================= 页面实例 =================

  const pageCache = new Map();

  function PageInstance(cfg, options, payload, host) {
    this.def = cfg;
    this.options = options || {};
    this.ast = payload.ast;
    this.host = host;
    this.data = clone(cfg.data || {});
    this.persistent = new Map();
    this.active = false;
    this.renderPending = false;

    Object.keys(cfg).forEach(k => {
      if (typeof cfg[k] === 'function') this[k] = cfg[k].bind(this);
    });
  }

  PageInstance.prototype.setData = function (patch, cb) {
    if (patch && typeof patch === 'object') {
      Object.keys(patch).forEach(k => setByPath(this.data, k, patch[k]));
    }
    if (this.active) this.scheduleRender();
    if (typeof cb === 'function') setTimeout(cb, 0);
  };

  PageInstance.prototype.scheduleRender = function () {
    if (this.renderPending) return;
    this.renderPending = true;
    requestAnimationFrame(() => {
      this.renderPending = false;
      if (this.active) this.render();
    });
  };

  PageInstance.prototype.render = function () {
    if (!this.active) return;
    ACTIVE.page = this;
    ACTIVE.host = this.host;
    renderTree(this.ast, this.data, this.host, this.persistent);
  };

  // ================= 对外 API =================

  const WXPreview = {
    app: null,
    location: { latitude: DEFAULT_LOCATION.latitude, longitude: DEFAULT_LOCATION.longitude },
    showBasemap: true,
    frameWidth: 375,
    hooks: {
      navigate() {},
      back() {},
      title() {},
      toast(t) { console.log('[toast]', t); },
      modal(title, content, cb) { cb(window.confirm(title ? title + '\n\n' + content : content)); },
      chooseLocation(cb) { cb(null); },
      stopPull() {}
    },
    onLog(fn) { logListeners.push(fn); },
    evaluate(src) {
      const module = { exports: {} };
      new Function('module', 'exports', 'console', src)(module, module.exports, console);
      return module.exports;
    },
    async loadPage(name, options) {
      const key = name + '|' + JSON.stringify(options || {});
      const cached = pageCache.get(key);
      const host = ACTIVE.host;

      if (cached) {
        if (ACTIVE.page && ACTIVE.page !== cached && typeof ACTIVE.page.onHide === 'function') {
          try { ACTIVE.page.onHide(); } catch (e) { console.error(e); }
        }
        setActive(cached);
        cached.render();
        if (typeof cached.onShow === 'function') {
          try { cached.onShow(); } catch (e) { console.error(e); }
        }
        return cached;
      }

      const payload = await WXPreview.fetchPayload(name);
      return WXPreview.mount(payload, options);
    },

    fetchPayload(name) {
      const cache = WXPreview._payloads || (WXPreview._payloads = new Map());
      if (cache.has(name)) return cache.get(name);
      const p = fetch('/api/page/' + name + '&_=' + Date.now())
        .then(r => r.json())
        .then(data => {
          if (data.error) throw new Error(data.error);
          return data;
        });
      cache.set(name, p);
      return p;
    },

    async mount(payload, options) {
      const host = ACTIVE.host;

      // 注入页面样式
      let style = document.getElementById('wx-page-css');
      if (!style) {
        style = document.createElement('style');
        style.id = 'wx-page-css';
        document.head.appendChild(style);
      }
      style.textContent = payload.css || '';

      // 执行 bundle（内部会调用 App / Page）
      let appCfg = null;
      let pageCfg = null;
      window.App = cfg => { appCfg = cfg; };
      window.Page = cfg => { pageCfg = cfg; };

      new Function(payload.js)();

      if (appCfg) {
        const app = Object.assign({}, appCfg);
        app.globalData = clone(appCfg.globalData || {});
        if (typeof app.onLaunch === 'function') app.onLaunch.call(app, {});
        WXPreview.app = app;
      }

      if (!pageCfg) throw new Error('页面没有调用 Page()');
      if (WXPreview.app) window.__previewApp = WXPreview.app;

      const inst = new PageInstance(pageCfg, options, payload, host);
      inst.__key = payload.name + '|' + JSON.stringify(options || {});
      pageCache.set(inst.__key, inst);

      setActive(inst);
      inst.render();

      try {
        if (typeof inst.onLoad === 'function') inst.onLoad(options || {});
        inst.render();
        if (typeof inst.onReady === 'function') inst.onReady();
        if (typeof inst.onShow === 'function') inst.onShow();
      } catch (e) {
        console.error('[预览] 页面生命周期出错', e);
      }
      return inst;
    },

    reset() {
      pageCache.clear();
      WXPreview._payloads = new Map();
      ACTIVE.page = null;
    }
  };

  function setActive(inst) {
    if (WXPreview._active && WXPreview._active !== inst && typeof WXPreview._active.onHide === 'function') {
      try { WXPreview._active.onHide(); } catch (e) { console.error(e); }
    }
    pageCache.forEach(p => { if (p !== inst) p.active = false; });
    inst.active = true;
    WXPreview._active = inst;
    ACTIVE.page = inst;
  }

  WXPreview.PageInstance = PageInstance;

  // 全局注入
  window.wx = wx;
  window.App = cfg => { window.__previewAppCfg = cfg; };
  window.getApp = () => WXPreview.app || { globalData: {} };
  window.WXPreview = WXPreview;
})();
