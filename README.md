# 阿墨的说话小人生成器 MTAG

> Moy's Talking Avatar Generator

两张图片，一段语音，自动生成说话动画 ✧(ᐛ )

纯前端运行：本地解码、零上传、零安装。基于 RMS 振幅分析 + 阈值/attack-release 平滑 + 随机眨眼的口型核心算法，渲染与导出（视频 / 透明 WebM / GIF）全部在浏览器完成。

**在线使用**：[https://moyf.github.io/mtag/](https://moyf.github.io/mtag/)

## 功能

- 拖入 2~4 张角色立绘（闭嘴/张嘴，眨眼×2 可选自动降级）
- 拖入音频（或无音频演示模式）→ 即时分析 → 预览播放
- 口型参数：振幅阈值、交替切换频率、attack/release
- 动效：说话弹跳（squash & stretch）、说话摇摆，停话自动回落
- 导出：WebCodecs + mediabunny 快速编码（回退 MediaRecorder）；透明底 WebM / 绿幕底 / GIF
- 移动端自适应布局

## 使用提示

- 推荐 Chrome / Edge（Safari 的 VP9 alpha 支持不稳）
- 导出是实时录制，时长 = 音频时长，期间请勿切换标签页

## 开发

本仓库为在线发布版（静态快照）。源码与开发版本见 ai-playground 仓库 `projects/lip-sync-web/`（私有）；轻量逻辑验证 `node verify.mjs`（33 项断言）。

## 许可

见源码仓库。在线版页面内含版权声明。
