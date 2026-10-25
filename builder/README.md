# MIKU Builder（MIKU 下載器）

從 GitHub 最新正式 Release 下載已編譯的 MIKU 安裝檔，和使用者勾選的擴充套件（`.github/workflows/extensions.yml` 編好的 `MIKU-ext-<id>-<版本>-<平台>.zip`），驗證 SHA-256 後安裝。使用者的電腦不需要任何編譯工具。

## 開發時直接執行

```
npx electron@33.2.1 builder
```

## 測試

```
cd builder && node --test test/*.test.js
```

## 打包

先從 [Electron 的 Release](https://github.com/electron/electron/releases/tag/v33.2.1) 下載對應平台的 zip 和 `SHASUMS256.txt`，再執行：

```
python3 builder/package.py --electron-zip electron-v33.2.1-win32-x64.zip --checksums SHASUMS256.txt --target win-x64
```

`--target` 可以是 `win-x64`、`mac-arm64`、`mac-x64`。Mac 版要在 Mac 上打包（需要 `ditto` 和 `codesign`），Windows 版在任何系統上都能打包。產出的 `MIKU-Builder-<版本>-<target>.zip` 放在 repo 根目錄。
