#!/usr/bin/env python3
"""Package the dependency-free Builder using an official Electron ZIP and its SHASUMS256.txt.
macOS is needed for packaging/signing Mac apps. Windows ZIPs can be assembled on either host.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile
import zipfile

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
FILES = ('package.json', 'main.js', 'preload.js', 'core.js', 'renderer.js', 'index.html', 'style.css', 'catalog.json')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--electron-zip', type=Path, required=True)
    parser.add_argument('--checksums', type=Path, required=True)
    parser.add_argument('--target', choices=['mac-arm64', 'mac-x64', 'win-x64'], required=True)
    parser.add_argument('--out', type=Path, default=REPO)
    parser.add_argument('--developer-id-app', default=os.environ.get('MIKU_DEVELOPER_ID_APP'))
    parser.add_argument('--no-preview', action='store_true', help='do not keep an unpacked Mac app beside the ZIP')
    args = parser.parse_args()
    platform, arch = args.target.split('-')
    expected_suffix = f'-{"darwin" if platform == "mac" else "win32"}-{arch}.zip'
    if not args.electron_zip.name.endswith(expected_suffix):
        parser.error('Electron ZIP does not match target')
    sums = {parts[1].lstrip('*'): parts[0] for line in args.checksums.read_text(encoding='utf-8').splitlines() if len(parts := line.split()) == 2}
    digest = hashlib.sha256(args.electron_zip.read_bytes()).hexdigest()
    if sums.get(args.electron_zip.name) != digest:
        parser.error('Electron ZIP SHA-256 verification failed')
    version = json.loads((HERE / 'package.json').read_text(encoding='utf-8'))['version']
    args.out.mkdir(parents=True, exist_ok=True)
    HERE.joinpath('work').mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='package-', dir=HERE / 'work') as tmp:
        work = Path(tmp)
        if platform == 'mac':
            subprocess.run(['ditto', '-x', '-k', str(args.electron_zip.resolve()), str(work)], check=True)
            bundle = work / 'MIKU Builder.app'
            (work / 'Electron.app').rename(bundle)
            (bundle / 'Contents/MacOS/Electron').rename(bundle / 'Contents/MacOS/MIKU Builder')
            resources = bundle / 'Contents/Resources'
            info_path = bundle / 'Contents/Info.plist'
            info = plistlib.loads(info_path.read_bytes())
            info.update(CFBundleName='MIKU Builder', CFBundleDisplayName='MIKU Builder',
                        CFBundleExecutable='MIKU Builder',
                        CFBundleIdentifier='com.miku.builder', CFBundleVersion=version,
                        CFBundleShortVersionString=version, LSMinimumSystemVersion='13.0',
                        NSHumanReadableCopyright='MIKU Builder', LSApplicationCategoryType='public.app-category.utilities')
            info.pop('ElectronAsarIntegrity', None)
            info_path.write_bytes(plistlib.dumps(info))
        else:
            bundle = work / 'MIKU Builder'
            bundle.mkdir()
            with zipfile.ZipFile(args.electron_zip) as archive:
                for name in archive.namelist():
                    target = (bundle / name).resolve()
                    if not target.is_relative_to(bundle.resolve()):
                        raise ValueError('Unsafe archive entry')
                archive.extractall(bundle)
            (bundle / 'electron.exe').rename(bundle / 'MIKU Builder.exe')
            resources = bundle / 'resources'
        (resources / 'default_app.asar').unlink(missing_ok=True)
        app = resources / 'app'
        app.mkdir(parents=True)
        for name in FILES:
            shutil.copy2(HERE / name, app / name)
        bridge = app / 'bridge'
        bridge.mkdir()
        # the small bridge core.js puts into an older MIKU snapshot it builds from source (prepareUpdater)
        for name in ('updater.js', 'BuilderUpdater.cs'):
            shutil.copy2(HERE / 'bridge' / name, bridge / name)
        if platform == 'mac':
            sign = args.developer_id_app or '-'
            signing = ['codesign', '--force', '--deep', '--sign', sign]
            if args.developer_id_app:
                signing += ['--options', 'runtime', '--entitlements', str(REPO / 'mac/build/entitlements.plist'), '--timestamp']
            subprocess.run(signing + [str(bundle)], check=True)
            subprocess.run(['codesign', '--verify', '--deep', '--strict', str(bundle)], check=True)
        output = args.out / f'MIKU-Builder-{version}-{args.target}.zip'
        if platform == 'mac':
            subprocess.run(['ditto', '-c', '-k', '--sequesterRsrc', '--keepParent', str(bundle), str(output)], check=True)
            # Keep the Apple Silicon preview beside the archives on this Mac.
            if arch == 'arm64' and not args.no_preview:
                preview = args.out / 'MIKU Builder.app'
                if preview.exists():
                    shutil.rmtree(preview)
                shutil.copytree(bundle, preview, symlinks=True)
        else:
            if os.environ.get('MIKU_WINDOWS_PFX'):
                subprocess.run([os.environ['MIKU_SIGNTOOL'], 'sign', '/fd', 'SHA256', '/tr', 'http://timestamp.digicert.com',
                                '/td', 'SHA256', '/f', os.environ['MIKU_WINDOWS_PFX'], '/p', os.environ['MIKU_WINDOWS_PFX_PASSWORD'],
                                str(bundle / 'MIKU Builder.exe')], check=True)
            with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
                for file in bundle.rglob('*'):
                    if file.is_file():
                        archive.write(file, file.relative_to(work))
        print(output)


if __name__ == '__main__':
    main()
