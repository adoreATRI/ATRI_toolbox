# ATRI Toolbox

![状态](https://img.shields.io/badge/状态-alpha-c6533d)
![平台](https://img.shields.io/badge/平台-Windows%20%7C%20Linux-2f6f6d)
![Electron](https://img.shields.io/badge/Electron-31-47848f)

ATRI Toolbox 是基于大模型辅助的工具箱

## 技术栈

- Electron
- Node.js
- HTML / CSS / JavaScript
- draw.io / diagrams.net 思维导图编辑
- 兼容 OpenAI Chat Completions 的大模型 API

## 工具

- **ATRI思维导图：** 支持根据描述辅助对思维导图的创建、修改和优化

## 下载

Windows 用户可以在 GitHub Releases 中下载安装版或便携版，无需本地编译。

## 配置

### 大模型 API 配置

在应用左侧点击“设置”，填写兼容 OpenAI Chat Completions 格式的接口信息。

| 配置项 | 说明 | 示例 |
| --- | --- | --- |
| Chat Completions Endpoint | 大模型接口地址 | `https://api.example.com/v1/chat/completions` |
| 模型 | 模型名称 | `gpt-4o-mini` |
| API Key | 服务商提供的密钥 | `sk-...` |
| Temperature | 生成发散程度，范围 0 到 2 | `0.3` |
