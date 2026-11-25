"""MoodWave's channel mode makes the now-playing page dark in every theme (white ink, its own dark backdrop), but a
theme's day look kept its light layers there (the calm lyrics panel, paper, cards): white lyrics on beige. This emits,
right after each rule, a copy of the theme's NIGHT look for #np scoped to channel mode, and keeps day-only #np rules out
of it, so the page is the theme's own night page whatever the app's mode.
    python3 mw_night.py in.css out.css"""
import re, sys
import os
HERE = os.path.dirname(os.path.abspath(__file__))
import importlib.util
spec = importlib.util.spec_from_file_location('split', os.path.join(HERE, '..', 'split-themes.py'))
sp = importlib.util.module_from_spec(spec); spec.loader.exec_module(sp)
MW = '[data-ext-source="moodchannels"]:not(.mc-radio)'
NP = re.compile(r'#np\b|\.np-(?!mini)|#lyrics\b|\.ly-|\.lyrics\b')
KEEP_MW = {'--np-base', '--np-ink', '--np-pill-ink', '--np-dim', '--np-veil'}   # MoodWave's own, it sets them on #np
# the player bar too: MoodWave lays the channel's dark picture across it, so a theme's day bar (dark icons, light chips)
# would vanish there; the bar takes the theme's night look, minus the white ink MoodWave sets on #bar itself
BAR = re.compile(r'#bar\b|\.seek\b')
KEEP_MW_BAR = {'--ink', '--line', '--line-2', '--text', '--text-hi', '--text-sub', '--text-2', '--text-3', '--surface-2', '--surface-3'}
def has_night(s): return 'data-mode="night"]' in s.replace(':not([data-mode="night"])', '')
def has_day(s): return '[data-mode="day"]' in s or ':not([data-mode="night"])' in s
def root_only(s):
    t = re.sub(r'\([^()]*\)', '', re.sub(r'\([^()]*\)', '', s.strip()))
    return 'data-theme' in s and not re.search(r'[\s>+~]|::', t)
def to_mw(s): return s.replace(':where([data-mode="night"])', MW).replace('[data-mode="night"]', MW)
def no_day(s): return s.replace('[data-mode="day"]', '[data-mode="day"]:not(' + MW + ')').replace(':not([data-mode="night"])', ':not([data-mode="night"]):not(' + MW + ')')
def decls(body):
    out, d, cur = [], 0, ''
    for ch in body:
        if ch == '(': d += 1
        elif ch == ')': d -= 1
        if ch == ';' and d == 0: out.append(cur); cur = ''
        else: cur += ch
    out.append(cur); return [x.strip() for x in out if x.strip()]
def vars_only(body, drop=KEEP_MW):
    keep = [x for x in decls(body) if x.startswith('--') and x.split(':', 1)[0].strip() not in drop]
    return ' ' + '; '.join(keep) + '; ' if keep else None
stats = {'np': 0, 'vars': 0, 'day': 0, 'bar': 0, 'barvars': 0}
NIGHT_BASE = set()   # themes whose plain colours are the night ones (their day look is a [data-mode="day"] block)
def theme_of(s):
    m = re.search(r'data-theme\^?="([a-z0-9]+)"', s); return m and m.group(1)
def scan(css):
    for pre, body, raw in sp.blocks(css):
        if body is None: continue
        if pre.startswith(('@media', '@supports', '@layer', '@container')): scan(body); continue
        if pre.startswith('@'): continue
        for s in sp.split_sel(pre):
            if root_only(s) and has_day(s) and theme_of(s): NIGHT_BASE.add(theme_of(s))
def walk(css):
    out = []
    for pre, body, raw in sp.blocks(css):
        if body is None: out.append(raw); continue
        if pre.startswith(('@media', '@supports', '@layer', '@container')):
            out.append(pre + ' {' + walk(body) + '}'); continue
        if pre.startswith('@'): out.append(raw); continue
        sels = sp.split_sel(pre)
        np_copy, var_copy, new = [], [], []
        for s in sels:
            s0 = s.strip()
            if (NP.search(s0) or BAR.search(s0)) and has_day(s0) and 'data-theme' in s0: s0 = no_day(s0); stats['day'] += 1
            new.append(s0)
            if root_only(s0) and not has_day(s0) and (has_night(s0) or theme_of(s0) in NIGHT_BASE):
                var_copy.append((to_mw(s0) if has_night(s0) else s0 + MW) + ' #np')
            elif has_night(s0) and (NP.search(s0) or BAR.search(s0)):
                np_copy.append(to_mw(s0))
        out.append(', '.join(new) + ' {' + body + '}')
        if var_copy:
            vb = vars_only(body)
            if vb: out.append('\n' + ', '.join(var_copy) + ' {' + vb + '}'); stats['vars'] += 1
            vb = vars_only(body, KEEP_MW_BAR)
            if vb: out.append('\n' + ', '.join(v[:-4] + ' #bar' for v in var_copy) + ' {' + vb + '}'); stats['barvars'] += 1
        if np_copy: out.append('\n' + ', '.join(np_copy) + ' {' + body + '}'); stats['np'] += 1
    return ''.join(out)
if __name__ == '__main__':
    src = open(sys.argv[1], encoding='utf-8').read()
    scan(src); print('night-base themes', sorted(NIGHT_BASE))
    res = walk(src)
    open(sys.argv[2], 'w', encoding='utf-8').write(res)
    print('mw_night', stats, len(src), '->', len(res))
