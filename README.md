<p align="center">
  <img src="public/assets/atri-logo.png" width="112" alt="ATRI Toolbox" />
</p>

<h1 align="center">ATRI Toolbox</h1>

<p align="center">基于 draw.io 和大模型辅助的跨平台思维导图工具箱</p>

<p align="center">
  <a href="https://github.com/adoreATRI/ATRI_toolbox/releases/latest"><img src="https://img.shields.io/github/v/release/adoreATRI/ATRI_toolbox?label=Release" alt="Release" /></a>
  <a href="https://github.com/adoreATRI/ATRI_toolbox/actions/workflows/release.yml"><img src="https://github.com/adoreATRI/ATRI_toolbox/actions/workflows/release.yml/badge.svg" alt="Build" /></a>
  <a href="https://github.com/adoreATRI/ATRI_toolbox/releases"><img src="https://img.shields.io/github/downloads/adoreATRI/ATRI_toolbox/total?label=Downloads" alt="Downloads" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/adoreATRI/ATRI_toolbox" alt="License" /></a>
  <img src="https://img.shields.io/badge/Platform-Windows%20%7C%20Linux-2f6f6d" alt="Windows and Linux" />
</p>

ATRI Toolbox 将 draw.io 编辑能力与自然语言修改结合在一个桌面应用中。用户可以直接绘制思维导图，也可以描述要新增的节点、关系、备注或标题，由本地解析器或兼容 OpenAI Chat Completions 的模型生成局部修改。

## 技术栈

- Electron 43
- Node.js 22
- HTML / CSS / JavaScript
- draw.io / diagrams.net 嵌入式编辑器
- electron-builder / electron-updater
- 兼容 OpenAI Chat Completions 的大模型 API

## 功能

- 使用完整的 draw.io 画布绘制、移动、缩放和调整节点
- 通过自然语言创建节点、修改标题与备注、连接关系
- 按关系语义选择普通连线、单向箭头、双向箭头和虚线
- 使用稳定的 draw.io 图元 ID 执行增量修改，保留无关节点的位置与样式
- 将一条描述作为一次原子操作，可通过 `Ctrl+Z` 撤回
- 导入和导出 `.drawio`、`.xml` 与兼容的 JSON 文件
- 收合左侧描述面板，为画布提供更大空间
- 自动检查 GitHub Releases，并下载和安装 Windows / Linux 更新

## 下载

前往 [GitHub Releases](https://github.com/adoreATRI/ATRI_toolbox/releases/latest) 下载已构建版本，无需自行编译。

| 平台 | 文件 | 说明 |
| --- | --- | --- |
| Windows | `ATRI Toolbox Setup *.exe` | 安装版，推荐使用 |
| Windows | `ATRI Toolbox *.exe` | 便携版，下载后直接运行 |
| Linux | `*.AppImage` | 通用便携版 |
| Debian / Ubuntu | `*.deb` | 系统安装包 |

应用启动约 4 秒后自动检查更新，并每 6 小时重新检查一次。也可以通过菜单栏的“帮助 > 检查更新”立即检查。下载完成后可立即重启安装，或在退出应用时安装；Linux `.deb` 更新可能要求输入管理员密码。

当前发布包未配置商业代码签名证书。Windows 首次运行时可能显示安全提醒。

## 使用

1. 启动应用并在 draw.io 画布中绘制节点。
2. 在左侧输入修改描述，按 `Enter` 发送；使用 `Shift+Enter` 换行。
3. 等待修改完成。处理期间画布会暂时锁定。
4. 修改不符合预期时按 `Ctrl+Z` 撤回。

### 大模型 API

本地解析器会直接处理名称明确的常用指令。复杂描述需要在“设置”中配置兼容 OpenAI Chat Completions 的接口。

| 配置项 | 说明 | 示例 |
| --- | --- | --- |
| Chat Completions Endpoint | 接口地址 | `https://api.example.com/v1/chat/completions` |
| 模型 | 服务商提供的模型名称 | `model-name` |
| API Key | 接口密钥 | `sk-...` |
| Temperature | 生成发散程度，范围 0 到 2 | `0.3` |

接口设置和导图数据保存在本机应用存储中。draw.io 编辑器、大模型接口和版本检查需要网络连接。

## 本地开发

要求 Node.js `>=22.12` 和 npm。

```bash
git clone https://github.com/adoreATRI/ATRI_toolbox.git
cd ATRI_toolbox
npm install
npm start
```

常用命令：

```bash
npm run check          # 语法检查和测试
npm run serve          # 仅启动本地 Web 服务
npm run package:linux  # 构建 AppImage 和 deb
npm run package:win    # 构建 NSIS 安装版和便携版
```

## 项目结构

```text
desktop/       Electron 主进程、启动器和退出协调器
public/        页面、样式、draw.io 集成和 XML 操作
test/          协议、服务与桌面生命周期测试
mindmap-ai.js  AI 增量操作协议和本地描述解析
server.js      本地 HTTP 服务与模型接口
```

## 贡献

1. Fork 仓库并从 `main` 创建分支。
2. 保持改动聚焦，并为行为变化补充测试。
3. 运行 `npm run check`。
4. 提交说明清晰的 Pull Request。

## 致谢

- [jgraph/drawio](https://github.com/jgraph/drawio) 提供图形编辑能力
- [electron-userland/electron-builder](https://github.com/electron-userland/electron-builder) 提供跨平台构建与更新能力

## License

本项目基于 [MIT License](LICENSE) 发布。
