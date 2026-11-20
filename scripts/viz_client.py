#!/usr/bin/env python3
"""camodel-viz 桥接客户端：向页面下发命令并取回结果。

用法示例：
  viz_client.py --port 47131 hello
  viz_client.py --port 47131 stats --seg 2
  viz_client.py --port 47131 at --seg 2 --cycle 8500
  viz_client.py --port 47131 rounds --seg 2 --from 5 --to 10
  viz_client.py --port 47131 view --seg 2 --range 8000 9000
  viz_client.py --port 47131 highlight --seg 2 --range 8000 9000
  viz_client.py --port 47131 clear-highlight --seg 2
  viz_client.py --port 47131 load --json segs.json
"""
import argparse, json, sys, time, urllib.request

ap = argparse.ArgumentParser()
ap.add_argument('--port', type=int, default=47131)
ap.add_argument('--token', default=None)
ap.add_argument('--timeout', type=float, default=10)
ap.add_argument('op', choices=['hello', 'stats', 'at', 'rounds', 'view', 'highlight', 'clear-highlight', 'load'])
ap.add_argument('--seg', type=int, default=None)
ap.add_argument('--cycle', type=int, default=None)
ap.add_argument('--from', dest='frm', type=int, default=None)
ap.add_argument('--to', type=int, default=None)
ap.add_argument('--range', nargs=2, type=int, metavar=('C0', 'C1'))
ap.add_argument('--round', type=int, default=None)
ap.add_argument('--scale', type=float, default=None)
ap.add_argument('--json', dest='jsonfile', default=None)
a = ap.parse_args()

BASE = 'http://127.0.0.1:%d' % a.port
TOK = a.token or ''

def call(method, path, obj=None):
    req = urllib.request.Request(BASE + path, method=method)
    if TOK:
        req.add_header('X-Viz-Token', TOK)
    data = None
    if obj is not None:
        req.add_header('Content-Type', 'application/json')
        data = json.dumps(obj).encode()
    with urllib.request.urlopen(req, data=data, timeout=30) as r:
        return json.loads(r.read())

cmd = {'op': a.op}
if a.seg is not None: cmd['seg'] = a.seg
if a.cycle is not None: cmd['cycle'] = a.cycle
if a.frm is not None: cmd['from'] = a.frm
if a.to is not None: cmd['to'] = a.to
if a.range: cmd['c0'], cmd['c1'] = a.range
if a.round is not None: cmd['round'] = a.round
if a.scale is not None: cmd['scale'] = a.scale
if a.op == 'load':
    cmd['segs'] = json.load(open(a.jsonfile))

if False:
    pass

r = call('POST', '/cmd', cmd)
mid = r['id']
deadline = time.time() + a.timeout
since = 0
while time.time() < deadline:
    ev = call('GET', '/events?since=%d' % since)
    since = ev['since']
    for e in ev['events']:
        b = e['body']
        if e['kind'] == 'ev' and b.get('type') == 'result' and b.get('id') == mid:
            print(json.dumps(b, ensure_ascii=False, indent=2))
            sys.exit(0 if b.get('ok') else 1)
    time.sleep(0.15)
print(json.dumps({'error': 'timeout waiting result', 'id': mid}, ensure_ascii=False), file=sys.stderr)
sys.exit(2)
