#!/usr/bin/env python3
"""小程序本地 HTML 预览服务器（仅用 Python 标准库，无需安装任何依赖）。

作用：把 pages/*/*.wxml、*.wxss、*.js 实时转换成网页，在浏览器里预览，
省去每次改完代码都要切到微信开发者工具。改动保存后页面会自动刷新。

用法：
    python3 preview/server.py                # 启动并自动打开浏览器
    python3 preview/server.py --port 5199    # 指定端口
    python3 preview/server.py --no-open      # 不自动打开

注意：这只是开发期的近似预览（WXML 指令、wx API 用 JS 运行时模拟），
最终效果仍需在微信开发者工具/真机上确认。
"""

import argparse
import hashlib
import json
import os
import re
import traceback
import webbrowser
from html.parser import HTMLParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, unquote

PREVIEW_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(PREVIEW_DIR)

# 预览宽度 375px 时，1rpx = 0.5px
RPX_SCALE = 0.5

REQUIRE_RE = re.compile(r"require\(\s*['\"]([^'\"]+)['\"]\s*\)")


# ============ 文件工具 ============

def read_text(path):
    with open(path, encoding='utf-8') as f:
        return f.read()


def read_json(path):
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def project_rev():
    """页面/工具/根的 mtime 指纹，用于前端自动刷新。"""
    h = hashlib.sha1()
    targets = []
    for folder in ('pages', 'utils'):
        base = os.path.join(ROOT, folder)
        for dirpath, _dirnames, filenames in os.walk(base):
            for fn in sorted(filenames):
                if fn.endswith(('.js', '.wxml', '.wxss', '.json')):
                    targets.append(os.path.join(dirpath, fn))
    for fn in ('app.js', 'app.json', 'app.wxss'):
        p = os.path.join(ROOT, fn)
        if os.path.exists(p):
            targets.append(p)
    for p in sorted(targets):
        st = os.stat(p)
        h.update(f'{p}:{st.st_mtime_ns}:{st.st_size}'.encode())
    return h.hexdigest()[:12]


# ============ WXML → AST ============

class WxmlParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = {'t': 'root', 'children': []}
        self.stack = [self.root]

    def handle_starttag(self, tag, attrs):
        node = {'t': 'el', 'tag': tag, 'attrs': dict(attrs), 'children': []}
        self.stack[-1]['children'].append(node)
        self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.stack[-1]['children'].append({
            't': 'el', 'tag': tag, 'attrs': dict(attrs), 'children': []
        })

    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i]['tag'] == tag:
                del self.stack[i:]
                return

    def handle_data(self, data):
        # 丢掉纯缩进换行，保留有内容的文本节点
        if data.strip() == '' and '\n' in data:
            return
        self.stack[-1]['children'].append({'t': 'txt', 'v': data})


def parse_wxml(text):
    parser = WxmlParser()
    parser.feed(text)
    parser.close()
    return parser.root


# ============ WXSS ============

def transform_wxss(css):
    # rpx → px（按 375px 预览宽度）
    css = re.sub(r'(-?\d*\.?\d+)rpx', lambda m: f'{float(m.group(1)) * RPX_SCALE:.2f}px', css)
    # 全局 page 选择器 → 预览容器
    css = re.sub(r'(^|[}\s,])page(?=[\s,{])', r'\1.wx-page', css)
    return css


# ============ JS 打包（CommonJS → 浏览器） ============

def resolve_spec(base_dir, spec):
    if not spec.startswith('.'):
        return None
    path = os.path.normpath(os.path.join(base_dir, spec))
    if not os.path.exists(path) and os.path.exists(path + '.js'):
        path += '.js'
    return path if os.path.exists(path) else None


def collect_modules(entry_abs):
    seen = {}
    order = []

    def walk(path):
        if path in seen:
            return
        seen[path] = True
        code = read_text(path)
        order.append((path, code))
        for spec in REQUIRE_RE.findall(code):
            dep = resolve_spec(os.path.dirname(path), spec)
            if dep:
                walk(dep)

    walk(os.path.normpath(entry_abs))
    return order


def module_id(path):
    return '/' + os.path.relpath(path, ROOT).replace(os.sep, '/')


def build_bundle(entry_abs, extra_entries=()):
    """生成一个自包含的 CommonJS 运行时；先执行 app.js，再暴露页面模块。"""
    modules = collect_modules(entry_abs)
    known = {module_id(p) for p, _ in modules}
    for extra in extra_entries:
        path = os.path.normpath(extra)
        if os.path.exists(path):
            for p, code in collect_modules(path):
                mid = module_id(p)
                if mid not in known:
                    modules.append((p, code))
                    known.add(mid)

    chunks = ['(function(){', 'var __mods = {};']
    for path, code in modules:
        chunks.append('__mods[%s] = function(module, exports, require){\n%s\n};'
                      % (json.dumps(module_id(path)), code))

    chunks.append(r"""
var __cache = {};
function __resolve(from, spec){
  if (spec.charAt(0) !== '.') return spec;
  var base = from.split('/');
  base.pop();
  spec.split('/').forEach(function(seg){
    if (seg === '..') base.pop();
    else if (seg !== '.' && seg !== '') base.push(seg);
  });
  var p = base.join('/');
  if (!/\.js$/.test(p)) p += '.js';
  return p;
}
function __require(id){
  if (__cache[id]) return __cache[id].exports;
  var m = {exports: {}};
  __cache[id] = m;
  var factory = __mods[id];
  if (!factory) throw new Error('模块未打包: ' + id);
  factory(m, m.exports, function(spec){ return __require(__resolve(id, spec)); });
  return m.exports;
}
window.__previewRequire = __require;
window.__previewEntry = """)
    chunks.append(json.dumps(module_id(entry_abs)))
    chunks.append(';})();')
    return '\n'.join(chunks)


# ============ 页面数据 ============

def find_page_path(name):
    app = read_json(os.path.join(ROOT, 'app.json'))
    for p in app.get('pages', []):
        if os.path.basename(p) == name:
            return p, app
    raise KeyError(f'未知页面: {name}')


def page_payload(name):
    rel, app = find_page_path(name)
    base = os.path.join(ROOT, rel)

    page_json_path = base + '.json'
    page_json = read_json(page_json_path) if os.path.exists(page_json_path) else {}

    css_parts = []
    for path in (os.path.join(ROOT, 'app.wxss'), base + '.wxss'):
        if os.path.exists(path):
            css_parts.append(f'/* {os.path.relpath(path, ROOT)} */\n' + transform_wxss(read_text(path)))

    js = build_bundle(base + '.js', [os.path.join(ROOT, 'app.js')])

    title = (page_json.get('navigationBarTitleText')
             or app.get('window', {}).get('navigationBarTitleText')
             or name)

    return {
        'name': name,
        'title': title,
        'ast': parse_wxml(read_text(base + '.wxml')),
        'css': '\n'.join(css_parts),
        'js': js,
    }


def pages_meta():
    app = read_json(os.path.join(ROOT, 'app.json'))
    names = [os.path.basename(p) for p in app.get('pages', [])]
    tabs = []
    for item in (app.get('tabBar') or {}).get('list', []):
        tabs.append({'name': os.path.basename(item.get('pagePath', '')), 'text': item.get('text', '')})
    titles = {}
    for n in names:
        try:
            rel, _ = find_page_path(n)
            p = os.path.join(ROOT, rel + '.json')
            titles[n] = read_json(p).get('navigationBarTitleText', n) if os.path.exists(p) else n
        except Exception:
            titles[n] = n
    return {'pages': [{'name': n, 'title': titles[n]} for n in names], 'tabs': tabs}


# ============ HTTP ============

class Handler(BaseHTTPRequestHandler):
    server_version = 'WxPreview/1.0'

    def log_message(self, fmt, *args):  # 降低噪音
        if '/api/rev' in self.path:
            return
        print('  ' + fmt % args)

    def send_bytes(self, body, content_type, status=200):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, obj, status=200):
        self.send_bytes(json.dumps(obj).encode('utf-8'), 'application/json; charset=utf-8', status)

    def send_file(self, path, content_type):
        if not os.path.exists(path):
            return self.send_error(404, 'File not found')
        self.send_bytes(read_text(path).encode('utf-8'), content_type)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)

        try:
            if path in ('/', '/index.html'):
                return self.send_file(os.path.join(PREVIEW_DIR, 'shell.html'), 'text/html; charset=utf-8')
            if path == '/runtime.js':
                return self.send_file(os.path.join(PREVIEW_DIR, 'runtime.js'),
                                      'application/javascript; charset=utf-8')
            if path == '/api/rev':
                return self.send_bytes(project_rev().encode(), 'text/plain; charset=utf-8')
            if path == '/api/pages':
                return self.send_json(pages_meta())
            if path == '/api/source':
                rel = parse_qs(parsed.query).get('path', [''])[0]
                full = os.path.normpath(os.path.join(ROOT, rel))
                if not full.startswith(ROOT + os.sep) or not full.endswith('.js'):
                    return self.send_error(403, 'Forbidden')
                return self.send_file(full, 'application/javascript; charset=utf-8')
            if path.startswith('/api/page/'):
                name = path.rsplit('/', 1)[-1]
                return self.send_json(page_payload(name))
            return self.send_error(404, 'Not found')
        except KeyError as e:
            return self.send_json({'error': str(e)}, 404)
        except Exception:
            traceback.print_exc()
            return self.send_json({'error': traceback.format_exc()}, 500)


def main():
    ap = argparse.ArgumentParser(description='小程序本地 HTML 预览服务器')
    ap.add_argument('--port', type=int, default=5199)
    ap.add_argument('--host', default='127.0.0.1')
    ap.add_argument('--no-open', action='store_true')
    args = ap.parse_args()

    url = f'http://{args.host}:{args.port}/'
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f'小程序预览已启动: {url}')
    print('改动保存后浏览器会自动刷新（Ctrl+C 结束）')
    if not args.no_open:
        webbrowser.open(url)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print('\n已停止')


if __name__ == '__main__':
    main()
