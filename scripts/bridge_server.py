#!/usr/bin/env python3
"""camodel-viz 桥接服务器：可视化页面 <--> 本桥 <--> agent（如 DSH）。

页面侧：timeline.html?bridge=PORT[&token=T] 自动连接（长轮询 /next，结果 POST /event）。
Agent 侧：
  POST /cmd  {"op":"stats","seg":1}            -> 入队，返回 {"id":N}
  GET  /events?since=0                         -> 取页面回传的 result（含 id）
  GET  /hello                                 -> 桥状态
简化用法见 scripts/viz_client.py。

只绑 127.0.0.1。--token 可选配；不配则本机任意进程可调用（单人本机开发口径，
与 dsh-excalidraw-bridge 相同）。
"""
import argparse, json, threading, time, urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ST = {
    'cond': threading.Condition(),
    'q': [],        # 给页面的命令 [{seq, id, cmd}]
    'ev': [],       # 页面/桥产生的事件 [{seq, body}]
    'seq': 0,
    'tok': None,
    'app': 'camodel-viz-bridge',
    'ver': '1.0',
}

def push(kind, obj):
    with ST['cond']:
        ST['seq'] += 1
        rec = {'seq': ST['seq'], 'kind': kind, 'body': obj}
        (ST['q'] if kind == 'cmd' else ST['ev']).append(rec)
        ST['cond'].notify_all()
        return ST['seq']

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _log(self, extra=''):
        import sys as _s
        print('%s %s%s q=%d ev=%d' % (self.command, self.path, extra, len(ST['q']), len(ST['ev'])), file=_s.stderr, flush=True)
    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type,X-Viz-Token')
    def _ok(self, obj, code=200):
        data = json.dumps(obj).encode()
        self.send_response(code); self._cors()
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data))); self.end_headers()
        self.wfile.write(data)
    def _deny(self):
        self._ok({'error': 'token mismatch'}, 403)
    def _auth(self):
        if not ST['tok']:
            return True
        qt = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).get('token', [''])[0]
        return qt == ST['tok'] or self.headers.get('X-Viz-Token') == ST['tok']
    def do_OPTIONS(self):
        self.send_response(200); self._cors(); self.end_headers()
    def do_GET(self):
        if not self._auth(): return self._deny()
        u = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(u.query)
        if u.path == '/hello':
            return self._ok({'app': ST['app'], 'ver': ST['ver'],
                             'queued': len(ST['q']), 'events': len(ST['ev']),
                             'token_required': bool(ST['tok'])})
        if u.path == '/next':  # 页面长轮询取命令（取出即出队，单页面消费者口径）
            since = int(qs.get('since', ['0'])[0])
            deadline = time.time() + 25
            with ST['cond']:
                while time.time() < deadline:
                    idx = next((i for i, r in enumerate(ST['q']) if r['seq'] > since), None)
                    if idx is not None:
                        rec = ST['q'].pop(idx)
                        return self._ok({'since': ST['seq'], 'cmd': rec})
                    ST['cond'].wait(timeout=2)
                return self._ok({'since': ST['seq']})
        if u.path == '/events':  # agent 取页面结果
            since = int(qs.get('since', ['0'])[0])
            return self._ok({'since': ST['seq'], 'events': [r for r in ST['ev'] if r['seq'] > since]})
        return self._ok({'error': 'unknown path'}, 404)
    def do_POST(self):
        if not self._auth(): return self._deny()
        u = urllib.parse.urlparse(self.path)
        n = int(self.headers.get('Content-Length', '0'))
        try:
            body = json.loads(self.rfile.read(n) or b'{}')
        except Exception:
            return self._ok({'error': 'bad json'}, 400)
        if u.path == '/cmd':
            seq = push('cmd', body)
            return self._ok({'id': seq})
        if u.path == '/event':
            seq = push('ev', body)
            return self._ok({'seq': seq})
        return self._ok({'error': 'unknown path'}, 404)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=47131, help='起始端口（占用时 +1 顺试 20 个）')
    ap.add_argument('--token', default=None)
    a = ap.parse_args()
    ST['tok'] = a.token
    for p in range(a.port, a.port + 20):
        try:
            srv = ThreadingHTTPServer(('127.0.0.1', p), H)
            break
        except OSError:
            continue
    else:
        raise SystemExit('no free port in %d..%d' % (a.port, a.port + 19))
    print('bridge listening on 127.0.0.1:%d token=%s' % (p, ST['tok'] or '(none)'), flush=True)
    srv.serve_forever()

if __name__ == '__main__':
    main()
