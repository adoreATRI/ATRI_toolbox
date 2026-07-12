<p align="center">
  <img src="public/assets/atri-logo.png" width="112" alt="ATRI Toolbox" />
</p>

<h1 align="center">ATRI Toolbox</h1>

<p align="center">ATRI Toolbox 是基于大模型辅助的工具箱</p>

<p align="center">
  <a href="https://github.com/adoreATRI/ATRI_toolbox/releases/latest"><img src="https://img.shields.io/github/v/release/adoreATRI/ATRI_toolbox?label=Release" alt="Release" /></a>
  <a href="https://github.com/adoreATRI/ATRI_toolbox/actions/workflows/release.yml"><img src="https://github.com/adoreATRI/ATRI_toolbox/actions/workflows/release.yml/badge.svg" alt="Build" /></a>
  <a href="https://github.com/adoreATRI/ATRI_toolbox/releases"><img src="https://img.shields.io/github/downloads/adoreATRI/ATRI_toolbox/total?label=Downloads" alt="Downloads" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/adoreATRI/ATRI_toolbox" alt="License" /></a>
  <img src="https://img.shields.io/badge/Platform-Windows%20%7C%20Linux-2f6f6d" alt="Windows and Linux" />
</p>



## 主要功能

- ATRI 思维导图：基于 draw.io 的思维导图编辑器，支持大模型辅助生成内容。
- 导入 `.drawio` 或 `.xml` 后持续写回原文件，并在桌面端保留大模型 API 设置。

## 下载

| 平台 | 文件 | 说明 |
| --- | --- | --- |
| Windows | `ATRI Toolbox Setup *.exe` | 安装版，推荐使用 |
| Windows | `ATRI Toolbox *.exe` | 便携版，下载后直接运行 |
| Linux | `*.AppImage` | 通用便携版 |
| Debian / Ubuntu | `*.deb` | 系统安装包 |

## 本地开发

要求 Node.js `>=22.12` 和 npm。

```bash
git clone https://github.com/adoreATRI/ATRI_toolbox.git
cd ATRI_toolbox
npm install
npm start
```

```bash
npm run check
npm run package:linux
npm run package:win
```

## License

本项目基于 [MIT License](LICENSE) 发布。
