#!/usr/bin/env python3
"""camodel 仿真日志解析器（camodel-viz skill 组件）。

两种模式：
  pipe（默认）：解析 evidence 目录下的 per-pipe issue-queue dump
    （*mte2_issque.dump / *mte3_issque.dump / *vec_issque.dump / *.bmu.dump，
    silu-mul 旧格式里 bmu.dump 与 mte2_issque 同内容也兼容），
    输出泳道图 SEGS JSON（多 launch 段、静态/BMU 自动分类、轮结构自动推断）。
  driver：解析驱动级日志（TASK_BEGIN/DONE + block_start/early_end/block_end），
    输出块调度甘特图 JSON。

用法：
  parse_dumps.py EVIDENCE_DIR [MORE_DIR ...] [-o out.json]
  parse_dumps.py DRIVER_LOG [-o out.json] [--mode driver]
"""
import argparse, json, re, os, sys

LINE = re.compile(r'^\[info\] (\d+) \[([^\]]+)\](?: (.*))?$')
FLD  = re.compile(r'(?:instr\.)?name=(\S+).*?(?:instr\.)?pc=0x([0-9A-Fa-f]+).*?(?:instr\.)?id=(\d+)')
TRAILER = re.compile(r'start: (\d+), tick: (\d+).*?taskId: (\d+)')
BLK = re.compile(r'\[info\] \[(\d+)\] \[(block_start|block_end|early_end)\]\s*: AIV, rtsq_id=(\d+), task_id=(\d+), (?:full_task_id=(\d+), )?core_id=(\d+), block_id=(\d+)')
TASK = re.compile(r'\[info\] \[(\d+)\] \[(TASK_BEGIN|TASK_DONE)\].*stream_id:(\d+), task_id:(\d+) full_task_id:(\d+)')

def read_lines(path):
    try:
        with open(path, errors='replace') as f:
            return [l.rstrip('\n') for l in f]
    except FileNotFoundError:
        return []

def parse_stream(path):
    """-> [(events, meta)] 按 trailer 行切 launch 段；events=[(cyc,kind,rest)]。"""
    segs, cur = [], []
    for ln in read_lines(path):
        if 'done+++' in ln:
            m = TRAILER.search(ln)
            meta = {'start': int(m.group(1)), 'tick': int(m.group(2)), 'task': int(m.group(3))} if m else {}
            segs.append((cur, meta)); cur = []
            continue
        m = LINE.match(ln)
        if m:
            cur.append((int(m.group(1)), m.group(2), m.group(3) or ''))
    if cur:
        segs.append((cur, {}))
    return segs

def pair_events(events):
    """events -> [{name,pc,push,pop,retire,setpush,rel,setrel}] 按 id 配对三态。"""
    d = {}
    for cyc, k, rest in events:
        m = FLD.search(rest)
        if not m:
            continue
        e = d.setdefault((m.group(1), m.group(2), m.group(3)), {'name': m.group(1), 'pc': m.group(2)})
        if k == 'Push Instr': e['push'] = cyc
        elif k == 'pop Instr': e['pop'] = cyc
        elif k == 'RETIRE INSTR': e['retire'] = cyc
        elif k == 'Push Set Instr': e.setdefault('setpush', cyc)
        elif k == 'release wait_flag': e['rel'] = cyc
        elif k == 'release set_flag': e.setdefault('setrel', cyc)
        elif k == 'release bar': e.setdefault('barrel', cyc)
    return list(d.values())

def tri(v):
    return [v.get('push'), v.get('pop'), v.get('retire')]

def assign_rows(pairs):
    its = sorted((p[0], p[1], i) for i, p in enumerate(pairs))
    last = []
    for po, re_, idx in its:
        k = 0
        while k < len(last) and last[k] > po: k += 1
        if k == len(last): last.append(re_)
        else: last[k] = re_
    return len(last)

def build_segment(idx, kind_hint, m2s, m3s, vss, bmu_lines, meta):
    m2, m2meta = m2s
    m3, m3meta = m3s
    vs, vsmeta = vss
    a2, a3, av = pair_events(m2), pair_events(m3), pair_events(vs)
    loads = sorted([v for v in a2 if v['name'].startswith('MOV_SRC_TO_DST')], key=lambda v: v.get('push') or 0)
    stores = sorted([v for v in a3 if v['name'].startswith('MOV_SRC_TO_DST')], key=lambda v: v.get('push') or 0)
    # 轮结构：load 数能整除 store 数时按每轮 lpr 条分组，否则每 load 自成一轮
    if stores and len(loads) % len(stores) == 0 and len(stores) > 0:
        lpr = max(1, len(loads) // len(stores))
        loads_r = [[tri(x) for x in loads[i:i+lpr]] for i in range(0, len(loads), lpr)]
    else:
        loads_r = [[tri(x)] for x in loads]
    vecp = sorted(v.get('push') for v in av if v.get('push') is not None)
    alloc, addr = [], []
    for ln in bmu_lines:
        m = re.search(r'^(\[info\] )?(\d+) bufferId:(\d+).*alloc_addr, partition:\d+, addr:(0x[0-9a-f]+)', ln)
        if m:
            alloc.append(int(m.group(2))); addr.append(int(m.group(4), 16))
    free = sorted(v.get('setpush') for v in a3 if v['name'] == 'BUF_FREE' and v.get('setpush') is not None)
    w2 = sorted([(v.get('push'), v.get('rel')) for v in a2 if v['name'] == 'WAIT_FLAG' and 'rel' in v], key=lambda w: w[0] or 0)
    s2 = sorted(v.get('setrel') for v in a2 if v['name'] == 'SET_FLAG' and v.get('setrel') is not None)
    w3 = sorted([(v.get('push'), v.get('rel')) for v in a3 if v['name'] == 'WAIT_FLAG' and 'rel' in v], key=lambda w: w[0] or 0)
    s3 = sorted(v.get('setrel') for v in a3 if v['name'] == 'SET_FLAG' and v.get('setrel') is not None)
    bars = sorted(v.get('barrel') for v in a3 + a2 if v.get('barrel') is not None)
    allex = [v for v in a2 + a3 if v.get('push') is not None]
    span = [min(v['push'] for v in allex), max(v['retire'] for v in a2 + a3 if v.get('retire') is not None)]
    kind = 'bmu' if (alloc or free or vecp) else 'static'
    m2n = assign_rows([(l[1], l[2]) for rd in loads_r for l in rd]) if loads_r else 0
    m3n = assign_rows([(v.get('pop'), v.get('retire')) for v in stores]) if stores else 0
    return {'i': idx, 'task': meta.get('task', 0), 'kind': kind,
            'start': meta.get('start', vsmeta.get('start', m2meta.get('start', 0))),
            'tick': meta.get('tick', vsmeta.get('tick', m2meta.get('tick', 0))),
            'span': span, 'loads': loads_r, 'stores': [tri(v) for v in stores],
            'vecp': vecp, 'alloc': alloc, 'alloc_addr': addr, 'free': free,
            'wait2': w2, 'set2': s2, 'wait3': w3, 'set3': s3, 'bars': bars,
            '_m2n': m2n, '_m3n': m3n}

def parse_pipe_dirs(dirs):
    segs_out = []
    idx = 1
    for d in dirs:
        def find(*subs):
            for f in sorted(os.listdir(d)):
                if f.endswith('.dump') and any(s in f for s in subs):
                    return os.path.join(d, f)
            return None
        p_m2 = find('mte2_issque') or find('.bmu')  # silu-mul 旧格式：bmu.dump 与 mte2 同流
        p_m3 = find('mte3_issque')
        p_vs = find('vec_issque')
        p_bm = find('.bmu')
        s2, s3, sv = parse_stream(p_m2), parse_stream(p_m3), parse_stream(p_vs)
        bmu_lines = read_lines(p_bm) if p_bm else []
        n = max(len(s2), len(s3), len(sv))
        for k in range(n):
            def at(lst):
                return lst[k] if k < len(lst) else ([], {})
            seg = build_segment(idx, None, at(s2), at(s3), at(sv), bmu_lines,
                                at(s2)[1] or at(s3)[1] or at(sv)[1])
            seg['src'] = os.path.basename(d.rstrip('/'))
            del seg['_m2n'], seg['_m3n']
            segs_out.append(seg); idx += 1
    return segs_out

def parse_driver_log(path):
    ev, tasks = {}, []
    for ln in read_lines(path):
        m = BLK.search(ln)
        if m:
            cyc = int(m.group(1)); k = m.group(2); bid = int(m.group(7)); core = int(m.group(6))
            ev.setdefault(bid, {})[k] = cyc; ev[bid]['core'] = core
        m2 = TASK.search(ln)
        if m2:
            tasks.append({'cycle': int(m2.group(1)), 'kind': m2.group(2),
                          'stream': int(m2.group(3)), 'task': int(m2.group(4)), 'ftid': int(m2.group(5))})
    blocks = [{'bid': b, 'core': d['core'], 'start': d.get('block_start'),
               'early': d.get('early_end'), 'end': d.get('block_end')} for b, d in sorted(ev.items())]
    return {'tasks': tasks, 'blocks': blocks}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('inputs', nargs='+')
    ap.add_argument('-o', '--out', default='segs.json')
    ap.add_argument('--mode', choices=['pipe', 'driver'], default='pipe')
    a = ap.parse_args()
    if a.mode == 'driver':
        data = parse_driver_log(a.inputs[0])
    else:
        data = parse_pipe_dirs(a.inputs)
    with open(a.out, 'w') as f:
        json.dump(data, f, separators=(',', ':'))
    js = json.dumps(data, separators=(',', ':'))
    # 自检
    if a.mode == 'pipe':
        for sg in (data if isinstance(data, list) else []):
            nr = len(sg['stores'])
            per = round(median([sg['stores'][i+1][1]-sg['stores'][i][1] for i in range(nr-1)])) if nr > 1 else 0
            print('seg%d %-6s T=%d loads=%d stores=%d period=%d vecp=%d alloc/free=%d/%d w2/s2/w3/s3=%d/%d/%d/%d' % (
                sg['i'], sg['kind'], sg['tick']-sg['start'], len(sg['loads']), nr, per,
                len(sg['vecp']), len(sg['alloc']), len(sg['free']),
                len(sg['wait2']), len(sg['set2']), len(sg['wait3']), len(sg['set3'])), file=sys.stderr)
    else:
        bs = data['blocks']
        done = sum(1 for b in bs if None not in (b['start'], b['early'], b['end']))
        print('blocks=%d complete=%d tasks=%d' % (len(bs), done, len(data['tasks'])), file=sys.stderr)
    print('JSON bytes: %d -> %s' % (len(js), a.out), file=sys.stderr)

def median(x):
    b = sorted(x); m = len(b) // 2
    return b[m] if len(b) % 2 else (b[m-1] + b[m]) / 2

if __name__ == '__main__':
    main()
