"""
Splits one themes stylesheet into wwwroot/themes/common.css and wwwroot/themes/<id>.css (one per theme).

    python3 windows/split-themes.py <themes.css> windows/wwwroot/themes

A rule (or the part of a selector list) whose selector starts with :root[data-theme="x"] (also :root.lite-*[...],
[data-theme^="x"] for a family) goes to that theme's file; everything else, including the bare [data-theme] colour
blocks the picker's preview uses and every @keyframes, goes to common.css. Source order is kept inside each file,
and a comment goes with the rule after it. Only the current theme's file is loaded, right after common.css
(index.html, themes.js Theme.sheet). Add a new theme to THEMES here and to the id list in index.html's first script.
Then copy windows/wwwroot/themes to mac/app/wwwroot (mac/build/sync_wwwroot.py does it).
"""
import re, sys, json
THEMES = ['miku','wood','glass','flat','flat2','neon','washi','vinyl','sakura','terminal','pop','poster','luka','gold']
def blocks(css):
    """Top-level items: (prelude, body or None, raw). Handles comments/strings."""
    i, n, out = 0, len(css), []
    start = 0
    while i < n:
        c = css[i]
        if css.startswith('/*', i):
            j = css.find('*/', i + 2); j = n if j < 0 else j + 2
            out.append(('comment', None, css[i:j])); i = j; start = i; continue
        if c in ' \t\r\n' and start == i: i += 1; start = i; out.append(('ws', None, c)); continue
        # read prelude up to { or ;
        j = i; depth = 0; q = None
        while j < n:
            ch = css[j]
            if q:
                if ch == '\\': j += 2; continue
                if ch == q: q = None
            elif ch in '"\'': q = ch
            elif ch == '(': depth += 1
            elif ch == ')': depth -= 1
            elif depth == 0 and ch in '{;': break
            elif css.startswith('/*', j):
                k = css.find('*/', j + 2); j = k + 2; continue
            j += 1
        if j >= n: out.append(('tail', None, css[i:])); break
        if css[j] == ';': out.append(('stmt', None, css[i:j+1])); i = j + 1; start = i; continue
        # find matching }
        k = j + 1; d = 1; q = None
        while k < n and d:
            ch = css[k]
            if q:
                if ch == '\\': k += 2; continue
                if ch == q: q = None
            elif ch in '"\'': q = ch
            elif css.startswith('/*', k):
                e = css.find('*/', k + 2); k = e + 2; continue
            elif ch == '{': d += 1
            elif ch == '}': d -= 1
            k += 1
        out.append((css[i:j].strip(), css[j+1:k-1], css[i:k])); i = k; start = i
    return out
def split_sel(s):
    parts, d, cur = [], 0, ''
    for ch in s:
        if ch == '(': d += 1
        elif ch == ')': d -= 1
        if ch == ',' and d == 0: parts.append(cur); cur = ''
        else: cur += ch
    parts.append(cur); return parts
REF = re.compile(r'\[data-theme(\^?)="([a-z0-9]+)"\]')
def owner(sel):
    """Set of themes this selector can match at, or None for any (common)."""
    s = sel.strip()
    if 'data-theme' not in s: return None
    if re.search(r':not\([^)]*data-theme', s): return None
    refs = list(REF.finditer(s))
    if len(refs) != 1: return None
    m = refs[0]
    before = s[:m.start()]
    # only when the theme is on the root element: ':root' / 'html' / ':root:root' / ':root.cls'
    if not re.fullmatch(r'(:root|html)(:root|\.[\w-]+)*', before): return None
    pre, name = m.group(1), m.group(2)
    return frozenset(t for t in THEMES if (t.startswith(name) if pre else t == name)) or None
def walk(css, buckets_text, keys):
    """Append each item to the buckets it belongs to. buckets_text: dict key->list."""
    pending = []
    def put(k, text):
        if pending:
            buckets_text[k].append('\n' + '\n'.join(pending) + '\n'); pending.clear()
        buckets_text[k].append(text)
    for pre, body, raw in blocks(css):
        if body is None:
            if pre == 'comment':
                pending.append(raw); continue
            if pre == 'ws':
                continue
            for k in keys: buckets_text[k].append(raw)   # @import/@charset etc: everywhere (rare)
            continue
        if pre.startswith('@media') or pre.startswith('@supports') or pre.startswith('@layer') or pre.startswith('@container'):
            sub = {k: [] for k in keys}
            walk(body, sub, keys)
            for k in keys:
                if ''.join(sub[k]).strip(): put(k, pre + ' {' + ''.join(sub[k]) + '}\n')
            continue
        if pre.startswith('@'):
            put('common', raw + '\n'); continue
        sels = split_sel(pre)
        per = {}
        for s in sels:
            o = owner(s)
            if o is None: per.setdefault('common', []).append(s.strip())
            else:
                for t in o: per.setdefault(t, []).append(s.strip())
        for k, ss in per.items():
            put(k, ', '.join(ss) + ' {' + body + '}\n')
HEAD = {
    'common': "/* MIKU themes: what every theme shares, the themes' colour blocks ([data-theme] without :root, also used by the\n   picker's preview) and the preview itself. Each theme's own rules (:root[data-theme=...]) are in themes/<id>.css, and\n   only the current theme's file is loaded (themes.js Theme.sheet): with all fourteen in one sheet, every element was\n   matched against all of them at every style pass. Loaded after this file. */\n\n",
    '*': "/* MIKU theme '{k}': its :root[data-theme] rules (shared rules: themes/common.css). Only the current theme's file is\n   loaded (themes.js Theme.sheet). A selector must start with :root[data-theme...] to belong here. */\n\n",
}
if __name__ == '__main__':
    src, outdir = sys.argv[1], sys.argv[2]
    css = open(src, encoding='utf-8').read()
    keys = ['common'] + THEMES
    b = {k: [] for k in keys}
    walk(css, b, keys)
    import os; os.makedirs(outdir, exist_ok=True)
    for k in keys:
        open(os.path.join(outdir, k + '.css'), 'w', encoding='utf-8').write(HEAD.get(k, HEAD['*']).format(k=k) + ''.join(b[k]).lstrip('\n'))
        print(k, len(''.join(b[k]).encode()))
