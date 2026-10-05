# VPicker

游戏内 F7 的 vp 立绘差分选择器的外部版，纯浏览器运行，不需要启动游戏。

- 点选姿势和表情，实时预览，并生成对应的 `PIC` 指令
- 粘贴 `PIC` 指令，自动切换到对应的姿势和表情
- 复制 / 保存 PNG（透明或自选背景色）
- 批处理：某个表情 × 所有姿势、某个姿势 × 所有表情，可复制全部指令或导出 ZIP

## 使用

**exe（推荐）**：从 [Releases](../../releases) 下载 `VPicker.exe`，双击运行。它会打开浏览器页面，关闭标签页后自动退出。

**从源码运行**：

```
npm install
npm run dev
```

打开页面后点「选择文件夹…」，选择游戏的 `StreamingAssets`（或其中的 `EvImg`）文件夹。文件只在本地读取，不会上传。

## 开发

```
npm test           # 依赖游戏数据的测试需设置环境变量 SA_DIR（StreamingAssets 路径），否则自动跳过
npm run build      # 网页
npm run build:exe  # 单文件 exe，输出到 release/
```

推送到 main 会触发 GitHub Actions（测试、构建、exe 冒烟测试）；推送 `v*` 标签会自动发布 exe 到 Releases。

## 许可证与声明

代码以 [MIT](LICENSE) 许可证发布。本项目不包含任何游戏资源，与游戏及其作者无关联；使用时请选择你自己的游戏文件。
