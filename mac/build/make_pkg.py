#!/usr/bin/env python3
"""
Builds MIKU.app (Apple Silicon + Intel) from the official Electron macOS builds and packs them into one
installer .pkg that picks the right one at install time.  Runs on Linux or macOS:

  python3 make_pkg.py --electron-dir DL --ffmpeg-dir DL --out OUT [--rcodesign PATH] [--mkbom PATH]

DL must contain electron-vX-darwin-{arm64,x64}.zip and ffmpeg/ffprobe-darwin-{arm64,x64}(.gz).
--fpcalc PATH adds Chromaprint's fpcalc (macOS universal binary) for 聲紋辨識.
"""
import argparse, gzip, hashlib, io, json, os, plistlib, shutil, stat, subprocess, sys, time, zlib, glob
from xml.sax.saxutils import escape

HERE = os.path.dirname(os.path.abspath(__file__))
APP_SRC = os.path.join(HERE, '..', 'app')
BUNDLE_ID = 'com.miku.player'


def sh(*cmd, **kw):
    print('+', ' '.join(map(str, cmd)))
    subprocess.check_call(cmd, **kw)


# ───────────────────────────── app bundle ─────────────────────────────
def build_app(arch, a, version, work):
    zips = sorted(glob.glob(os.path.join(a.electron_dir, f'electron-v*-darwin-{arch}.zip')))
    if not zips: sys.exit(f'missing Electron zip for {arch}')
    d = os.path.join(work, arch)
    shutil.rmtree(d, ignore_errors=True); os.makedirs(d)
    sh('unzip', '-q', zips[-1], '-d', d)          # unzip keeps the framework symlinks
    app = os.path.join(d, 'MIKU.app')
    os.rename(os.path.join(d, 'Electron.app'), app)
    res = os.path.join(app, 'Contents', 'Resources')
    for f in ('default_app.asar',):
        p = os.path.join(res, f)
        if os.path.exists(p): os.remove(p)
    # Chromium UI translations MIKU doesn't need (keeps the installer smaller)
    keep = {'en', 'en_GB', 'zh_TW', 'zh_CN', 'ja', 'Base'}
    fw_res = os.path.join(app, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Resources')
    for name in os.listdir(fw_res):
        if name.endswith('.lproj') and name[:-6] not in keep:
            shutil.rmtree(os.path.join(fw_res, name))
    # application code
    shutil.copytree(APP_SRC, os.path.join(res, 'app'), ignore=shutil.ignore_patterns('node_modules', '.DS_Store'))
    # FFmpeg / FFprobe
    bindir = os.path.join(res, 'bin'); os.makedirs(bindir)
    for tool in ('ffmpeg', 'ffprobe'):
        src = os.path.join(a.ffmpeg_dir, f'{tool}-darwin-{arch}')
        dst = os.path.join(bindir, tool)
        if os.path.exists(src + '.gz'):
            with gzip.open(src + '.gz', 'rb') as fi, open(dst, 'wb') as fo: shutil.copyfileobj(fi, fo)
        else: shutil.copyfile(src, dst)
        os.chmod(dst, 0o755)
    # fpcalc (Chromaprint, universal binary) for the tag editor's 聲紋辨識
    if a.fpcalc:
        shutil.copyfile(a.fpcalc, os.path.join(bindir, 'fpcalc')); os.chmod(os.path.join(bindir, 'fpcalc'), 0o755)
    # Native Core Audio output is independent of Electron's Node ABI.
    native = os.path.join(a.native_dir, f'miku-audio-{arch}')
    if not os.path.isfile(native): sys.exit(f'missing native Core Audio engine: {native}; run mac/native/build.sh on a Mac')
    shutil.copyfile(native, os.path.join(bindir, 'miku-audio')); os.chmod(os.path.join(bindir, 'miku-audio'), 0o755)
    # icon
    shutil.copyfile(os.path.join(HERE, 'MIKU.icns'), os.path.join(res, 'MIKU.icns'))
    try: os.remove(os.path.join(res, 'electron.icns'))
    except FileNotFoundError: pass
    # Info.plist
    ip = os.path.join(app, 'Contents', 'Info.plist')
    with open(ip, 'rb') as f: pl = plistlib.load(f)
    pl.update({
        'CFBundleName': 'MIKU', 'CFBundleDisplayName': 'MIKU', 'CFBundleIdentifier': BUNDLE_ID,
        'CFBundleShortVersionString': version, 'CFBundleVersion': version, 'CFBundleIconFile': 'MIKU.icns',
        'LSApplicationCategoryType': 'public.app-category.music', 'LSMinimumSystemVersion': '12.0',
        'NSHumanReadableCopyright': 'MIKU Music Player',
        'NSLocalNetworkUsageDescription': 'MIKU 需要區域網路來提供手機遙控功能。',
        'CFBundleDevelopmentRegion': 'zh_TW', 'NSHighResolutionCapable': True,
    })
    for k in ('NSCameraUsageDescription', 'NSBluetoothAlwaysUsageDescription', 'NSBluetoothPeripheralUsageDescription', 'NSMicrophoneUsageDescription', 'ElectronAsarIntegrity'):
        pl.pop(k, None)
    pl['NSMicrophoneUsageDescription'] = 'MIKU 不會錄音；這個權限只用於列出音訊輸出裝置名稱。'
    with open(ip, 'wb') as f: plistlib.dump(pl, f)
    # ad-hoc signature (Apple Silicon refuses to run unsigned code; editing the bundle broke Electron's own seal)
    if a.rcodesign:
        for tool in os.listdir(bindir):
            sh(a.rcodesign, 'sign', os.path.join(bindir, tool), stdout=subprocess.DEVNULL)
        sh(a.rcodesign, 'sign', app, stdout=subprocess.DEVNULL)
    elif shutil.which('codesign'):
        for tool in os.listdir(bindir):
            sh('codesign', '--force', '--sign', '-', os.path.join(bindir, tool))
        sh('codesign', '--force', '--deep', '--sign', '-', app)
    return app


# ───────────────────────────── cpio (odc) payload ─────────────────────────────
def cpio_odc(root, out):
    """Writes a POSIX.1 (odc) cpio archive of `root` with owner root:admin, gzip-compressed."""
    ino = [0]
    def entry(f, name, st_mode, data=b'', mtime=0, nlink=1):
        ino[0] += 1
        namez = name.encode() + b'\0'
        hdr = '070707%06o%06o%06o%06o%06o%06o%06o%011o%06o%011o' % (0, ino[0] & 0o777777, st_mode, 0, 80, nlink, 0, mtime, len(namez), len(data))
        f.write(hdr.encode()); f.write(namez); f.write(data)
    count = 0
    with open(out, 'wb') as raw, gzip.GzipFile(fileobj=raw, mode='wb', compresslevel=9, mtime=0) as f:
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames.sort(); filenames.sort()
            rel = os.path.relpath(dirpath, root)
            name = '.' if rel == '.' else './' + rel
            st = os.lstat(dirpath)
            entry(f, name, stat.S_IFDIR | 0o755, mtime=int(st.st_mtime), nlink=2); count += 1
            # symlinked directories show up in dirnames: emit them as links and don't descend
            for dn in list(dirnames):
                p = os.path.join(dirpath, dn)
                if os.path.islink(p):
                    entry(f, name + '/' + dn, stat.S_IFLNK | 0o755, os.readlink(p).encode(), int(os.lstat(p).st_mtime)); count += 1
                    dirnames.remove(dn)
            for fn in filenames:
                p = os.path.join(dirpath, fn)
                st = os.lstat(p)
                if stat.S_ISLNK(st.st_mode):
                    entry(f, name + '/' + fn, stat.S_IFLNK | 0o755, os.readlink(p).encode(), int(st.st_mtime))
                else:
                    mode = 0o755 if st.st_mode & 0o111 else 0o644
                    with open(p, 'rb') as fi: data = fi.read()
                    entry(f, name + '/' + fn, stat.S_IFREG | mode, data, int(st.st_mtime))
                count += 1
        entry(f, 'TRAILER!!!', 0, nlink=1)
    return count


_CRC = []
def cksum(data_iter, length):
    """POSIX cksum (what lsbom shows as a file's checksum)."""
    if not _CRC:
        for i in range(256):
            c = i << 24
            for _ in range(8): c = ((c << 1) ^ 0x04C11DB7) & 0xFFFFFFFF if c & 0x80000000 else (c << 1) & 0xFFFFFFFF
            _CRC.append(c)
    crc = 0
    for chunk in data_iter:
        for b in chunk: crc = ((crc << 8) & 0xFFFFFFFF) ^ _CRC[((crc >> 24) ^ b) & 0xFF]
    while length:
        crc = ((crc << 8) & 0xFFFFFFFF) ^ _CRC[((crc >> 24) ^ (length & 0xFF)) & 0xFF]; length >>= 8
    return (~crc) & 0xFFFFFFFF


def bom_list(root, out):
    """A file list in lsbom's format (owner root:admin, the payload's modes) for macOS's `mkbom -i`."""
    entries, files = [('.', '40755')], []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort(); filenames.sort()
        rel = os.path.relpath(dirpath, root)
        base = '.' if rel == '.' else './' + rel
        for dn in list(dirnames):
            p = os.path.join(dirpath, dn)
            if os.path.islink(p):
                t = os.readlink(p).encode()
                entries.append((f'{base}/{dn}', f'120755\t0/80\t{len(t)}\t{cksum([t], len(t))}\t{t.decode()}', True)); dirnames.remove(dn)
            else:
                entries.append((f'{base}/{dn}', '40755'))
        for fn in filenames:
            p = os.path.join(dirpath, fn); st = os.lstat(p)
            if stat.S_ISLNK(st.st_mode):
                t = os.readlink(p).encode()
                entries.append((f'{base}/{fn}', f'120755\t0/80\t{len(t)}\t{cksum([t], len(t))}\t{t.decode()}', True))
            else:
                entries.append((f'{base}/{fn}', p, st)); files.append(p)
    # file checksums with the system's cksum (fast); same result as cksum() above
    sums = {}
    for i in range(0, len(files), 200):
        outp = subprocess.check_output(['cksum'] + files[i:i + 200]).decode('utf-8', 'surrogateescape')
        for line, p in zip(outp.splitlines(), files[i:i + 200]):
            sums[p] = line.split()[0]
    lines = []
    for e in entries:
        if len(e) == 2: lines.append(f'{e[0]}\t{e[1]}\t0/80')
        elif e[2] is True: lines.append(f'{e[0]}\t{e[1]}')
        else:
            name, p, st = e
            mode = 0o100755 if st.st_mode & 0o111 else 0o100644
            lines.append(f'{name}\t{mode:o}\t0/80\t{st.st_size}\t{sums[p]}')
    with open(out, 'w') as f: f.write('\n'.join(lines) + '\n')


def make_bom(root, bom, mkbom):
    if mkbom:   # bomutils (Linux): forces the owner itself
        sh(mkbom, '-u', '0', '-g', '80', root, bom); return
    # macOS's mkbom has no -u / -g: give it a list with the owner (root:admin) instead
    lst = bom + '.list'
    bom_list(root, lst)
    try: sh('mkbom', '-i', lst, bom)
    except subprocess.CalledProcessError:
        print('mkbom -i failed, building the BOM from the folder itself')
        if os.path.exists(bom): os.remove(bom)
        sh('mkbom', root, bom)
    finally:
        try: os.remove(lst)
        except OSError: pass


def dir_kbytes(root):
    total = 0
    for dp, dn, fn in os.walk(root):
        for x in fn:
            p = os.path.join(dp, x)
            if not os.path.islink(p): total += os.path.getsize(p)
    return (total + 1023) // 1024


def component(app, arch, version, mkbom, out_dir):
    """Flat component package directory: PackageInfo, Bom, Payload."""
    ident = f'{BUNDLE_ID}.{arch}'
    root = os.path.join(out_dir, f'root-{arch}')
    shutil.rmtree(root, ignore_errors=True); os.makedirs(root)
    os.rename(app, os.path.join(root, 'MIKU.app'))
    comp = os.path.join(out_dir, f'MIKU-{arch}.pkg')
    shutil.rmtree(comp, ignore_errors=True); os.makedirs(comp)
    n = cpio_odc(root, os.path.join(comp, 'Payload'))
    make_bom(root, os.path.join(comp, 'Bom'), mkbom)
    kb = dir_kbytes(root)
    info = f'''<?xml version="1.0" encoding="utf-8"?>
<pkg-info overwrite-permissions="true" relocatable="false" identifier="{ident}" postinstall-action="none" version="{version}" format-version="2" generator-version="miku-make_pkg" install-location="/Applications" auth="root">
    <payload numberOfFiles="{n}" installKBytes="{kb}"/>
    <bundle path="./MIKU.app" id="{BUNDLE_ID}" CFBundleShortVersionString="{version}" CFBundleVersion="{version}"/>
    <bundle-version/>
    <upgrade-bundle/>
    <update-bundle/>
    <atomic-update-bundle/>
    <strict-identifier/>
    <relocate/>
</pkg-info>
'''
    with open(os.path.join(comp, 'PackageInfo'), 'w') as f: f.write(info)
    return ident, kb, comp


def distribution(version, parts):
    refs = ''.join(f'    <pkg-ref id="{ident}" version="{version}" installKBytes="{kb}" auth="root">#{os.path.basename(comp)}</pkg-ref>\n' for ident, kb, comp, arch in parts)
    arm = [p for p in parts if p[3] == 'arm64'][0]; intel = [p for p in parts if p[3] == 'x64'][0]
    return f'''<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
    <title>MIKU {version}</title>
    <options customize="never" require-scripts="false" rootVolumeOnly="true" hostArchitectures="arm64,x86_64"/>
    <domains enable_anywhere="false" enable_currentUserHome="false" enable_localSystem="true"/>
    <allowed-os-versions><os-version min="12.0"/></allowed-os-versions>
    <welcome file="welcome.html" mime-type="text/html"/>
    <conclusion file="conclusion.html" mime-type="text/html"/>
    <script><![CDATA[
function mikuArm() {{
    try {{ return system.sysctl('hw.optional.arm64') == 1; }} catch (e) {{ return false; }}
}}
]]></script>
    <choices-outline>
        <line choice="miku-arm64"/>
        <line choice="miku-x64"/>
    </choices-outline>
    <choice id="miku-arm64" title="MIKU (Apple Silicon)" visible="false" selected="mikuArm()" enabled="mikuArm()">
        <pkg-ref id="{arm[0]}"/>
    </choice>
    <choice id="miku-x64" title="MIKU (Intel)" visible="false" selected="!mikuArm()" enabled="!mikuArm()">
        <pkg-ref id="{intel[0]}"/>
    </choice>
{refs}</installer-gui-script>
'''

WELCOME = '''<html><head><meta charset="utf-8"><style>body{font-family:-apple-system,"PingFang TC",sans-serif;font-size:13px;line-height:1.6}</style></head><body>
<h2>MIKU 音樂播放器</h2>
<p>這個安裝程式會把 MIKU 安裝到「應用程式」資料夾，並自動選擇適合這台 Mac 的版本（Apple Silicon 或 Intel）。</p>
<p>需求：macOS 12 Monterey 或更新版本。</p>
</body></html>'''
CONCLUSION = '''<html><head><meta charset="utf-8"><style>body{font-family:-apple-system,"PingFang TC",sans-serif;font-size:13px;line-height:1.6}</style></head><body>
<h2>安裝完成</h2>
<p>到「應用程式」資料夾或 Launchpad 打開 <b>MIKU</b>。</p>
<p>第一次開啟時請在「設定 → 曲庫」加入音樂資料夾。若 macOS 詢問是否允許 MIKU 接受連入連線（手機遙控用），請按「允許」。</p>
</body></html>'''


# ───────────────────────────── xar ─────────────────────────────
def xar(out, tree):
    """tree: list of (name, path_or_None, children) — writes an uncompressed-data xar archive (flat .pkg)."""
    heap = io.BytesIO(); heap.write(b'\0' * 20)  # TOC checksum goes first
    ids = [0]
    def file_xml(name, path, children, indent):
        ids[0] += 1
        fid = ids[0]
        pad = '  ' * indent
        if children is not None:
            inner = ''.join(file_xml(n, p, c, indent + 1) for n, p, c in children)
            return f'{pad}<file id="{fid}"><name>{escape(name)}</name><type>directory</type><mode>0755</mode><uid>0</uid><gid>0</gid><user>root</user><group>wheel</group>\n{inner}{pad}</file>\n'
        h = hashlib.sha1(); size = 0
        off = heap.tell()
        with open(path, 'rb') as f:
            while True:
                b = f.read(1 << 20)
                if not b: break
                h.update(b); heap.write(b); size += len(b)
        dg = h.hexdigest()
        return (f'{pad}<file id="{fid}"><name>{escape(name)}</name><type>file</type><mode>0644</mode><uid>0</uid><gid>0</gid><user>root</user><group>wheel</group>'
                f'<data><length>{size}</length><offset>{off}</offset><size>{size}</size><encoding style="application/octet-stream"/>'
                f'<extracted-checksum style="sha1">{dg}</extracted-checksum><archived-checksum style="sha1">{dg}</archived-checksum></data></file>\n')
    body = ''.join(file_xml(n, p, c, 2) for n, p, c in tree)
    toc = ('<?xml version="1.0" encoding="UTF-8"?>\n<xar>\n <toc>\n'
           '  <checksum style="sha1"><offset>0</offset><size>20</size></checksum>\n'
           f'  <creation-time>{time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())}</creation-time>\n'
           f'{body} </toc>\n</xar>\n').encode()
    ztoc = zlib.compress(toc, 9)
    hb = heap.getbuffer()
    hb[0:20] = hashlib.sha1(ztoc).digest()
    with open(out, 'wb') as f:
        f.write(b'xar!' + (28).to_bytes(2, 'big') + (1).to_bytes(2, 'big') + len(ztoc).to_bytes(8, 'big') + len(toc).to_bytes(8, 'big') + (1).to_bytes(4, 'big'))
        f.write(ztoc); f.write(hb)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--electron-dir', required=True); ap.add_argument('--ffmpeg-dir', required=True)
    ap.add_argument('--out', required=True); ap.add_argument('--rcodesign'); ap.add_argument('--mkbom'); ap.add_argument('--fpcalc')
    ap.add_argument('--native-dir', default=os.path.join(HERE, 'native'))
    ap.add_argument('--work', default=os.path.join(HERE, 'work'))
    a = ap.parse_args()
    with open(os.path.join(APP_SRC, 'package.json')) as f: version = json.load(f)['version']
    os.makedirs(a.work, exist_ok=True); os.makedirs(a.out, exist_ok=True)
    parts = []
    for arch in ('arm64', 'x64'):
        app = build_app(arch, a, version, a.work)
        ident, kb, comp = component(app, arch, version, a.mkbom, a.work)
        parts.append((ident, kb, comp, arch))
    dist = os.path.join(a.work, 'Distribution')
    with open(dist, 'w') as f: f.write(distribution(version, parts))
    res = os.path.join(a.work, 'Resources'); os.makedirs(res, exist_ok=True)
    for n, t in (('welcome.html', WELCOME), ('conclusion.html', CONCLUSION)):
        with open(os.path.join(res, n), 'w') as f: f.write(t)
    tree = [('Distribution', dist, None),
            ('Resources', None, [('welcome.html', os.path.join(res, 'welcome.html'), None), ('conclusion.html', os.path.join(res, 'conclusion.html'), None)])]
    for ident, kb, comp, arch in parts:
        tree.append((os.path.basename(comp), None, [(n, os.path.join(comp, n), None) for n in ('Bom', 'PackageInfo', 'Payload')]))
    out = os.path.join(a.out, f'MIKU-{version}-mac.pkg')
    xar(out, tree)
    print('built', out, os.path.getsize(out) // (1 << 20), 'MB')


if __name__ == '__main__':
    main()
