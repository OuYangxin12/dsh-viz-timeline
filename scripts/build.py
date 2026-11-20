#!/usr/bin/env python3
"""camodel-viz：把解析得到的 JSON 注入 HTML 模板，生成自包含交互页面。

用法：
  build.py segs.json -t templates/timeline.html -o timeline.html \
      --title "jagged_to_dense 对比" --h1 "可选大标题" --note "可选说明段落"
"""
import argparse, json, re, subprocess, sys, tempfile, os

ap = argparse.ArgumentParser()
ap.add_argument('json', help='parse_dumps.py 的输出（pipe 模式为数组，driver 模式为对象）')
ap.add_argument('-t', '--template', required=True)
ap.add_argument('-o', '--out', required=True)
ap.add_argument('--title', default='camodel 泳道图')
ap.add_argument('--h1', default=None)
ap.add_argument('--note', default='')
a = ap.parse_args()

data = json.load(open(a.json))
tpl = open(a.template, encoding='utf-8').read()
out = (tpl
       .replace('__SEGS__', json.dumps(data, separators=(',', ':')))
       .replace('__TITLE__', a.title)
       .replace('__H1__', a.h1 or a.title))
if a.note:
    out = out.replace('__NOTE__', a.note)
else:
    out = re.sub(r'<p class="desc" id="note">__NOTE__</p>\n?', '', out)
open(a.out, 'w', encoding='utf-8').write(out)

m = re.search(r'<script>\n(.*)\n</script>', out, re.S)
if m:
    with tempfile.NamedTemporaryFile('w', suffix='.js', delete=False) as f:
        f.write(m.group(1)); tmp = f.name
    r = subprocess.run(['node', '--check', tmp], capture_output=True, text=True)
    os.unlink(tmp)
    if r.returncode != 0:
        print(r.stderr, file=sys.stderr)
        sys.exit(1)
    print('node --check OK')
print('wrote %s (%d bytes)' % (a.out, len(out.encode())))
