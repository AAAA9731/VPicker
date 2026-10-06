# VPicker

从游戏数据中提取所有 PXL 图像的工具：角色立绘（含姿势与表情差分）、事件 CG、UI、小游戏素材、敌人和 NPC 等。纯浏览器运行，不需要启动游戏。

**立绘**
- 点选姿势和表情，实时预览，并生成对应的 `PIC` 指令（即游戏内 F7 vp 选择器的外部版）
- 粘贴 `PIC` 指令，自动切换到对应的姿势和表情
- 批处理：某个表情 × 所有姿势、某个姿势 × 所有表情，可复制全部指令或导出 ZIP

**非立绘图片**（单独的标签页）
- 浏览并导出事件 CG、UI、小游戏素材、敌人、NPC 等其他 PXL 图片包
- 批处理：按连续序号序列（帧动画）、整个图片包，或按住 Ctrl 点击多选后导出 ZIP

**自定义图片（与 SimplePatch 联动）**
- 加载的文件夹里有 `SimplePatch_pic`（[SimplePatch](https://github.com/AAAA9731/SimplePatch) 的 PicLoad 补丁读取的文件夹）时，出现「自定义图片」标签页
- 在 16:9 的游戏窗口预览里摆放图片：拖动改位置，缩放按游戏支持的几档，窗口分辨率可选游戏里的 15 种，按真实大小显示；生成 `PIC_LOAD` / `PIC` / `PIC_MV` / `PIC_MVA` 指令
- 把 PNG 拖进页面即可导入（自动命名并打开重命名框），长按缩略图重命名（需用 exe 按路径加载）

**通用**
- 预览支持滚轮缩放、拖动平移、双击复位
- 复制 / 保存 PNG（透明或自选背景色），均为 1:1 原始分辨率
- exe 启动后自动检查 GitHub 上的新版本并提示更新

## 使用

**exe（推荐）**：从 [Releases](../../releases) 下载 `VPicker.exe`，双击运行。它会打开浏览器页面，关闭标签页后自动退出。

**macOS**：下载对应芯片的 `VPicker-macos-arm64.zip`（Apple 芯片）或 `VPicker-macos-x64.zip`（Intel），解压后在终端运行 `./VPicker`。
程序未做 Apple 开发者签名，首次运行若被系统拦截，执行 `xattr -dr com.apple.quarantine VPicker` 后再运行。

**从源码运行**：

```
npm install
npm run dev
```

exe 也可以直接带路径启动：`VPicker.exe --dir=D:\Game\AliceInCradle_Data\StreamingAssets`（或把文件夹拖到 exe 上）。页面里也能在「加载路径」框里填写路径。成功加载过的路径会被记住（Windows 在 `%APPDATA%\VPicker\config.json`），下次不带参数启动时自动填入并加载。

打开页面后点「选择文件夹…」，选择游戏的 `StreamingAssets`（或其中的 `EvImg`）文件夹。文件只在本地读取，不会上传。

## 开发

```
npm test           # 依赖游戏数据的测试需设置环境变量 SA_DIR（StreamingAssets 路径），否则自动跳过
npm run build      # 网页
npm run build:exe  # 单文件可执行程序（Windows 为 exe，macOS 为 zip），输出到 release/
```

推送到 main 会触发 GitHub Actions，在 Windows、macOS（arm64 / x64）上分别测试、构建并做启动冒烟测试；推送 `v*` 标签会自动发布三个平台的程序到 Releases。
页面本身在 Chrome / Edge / Safari 等现代浏览器中都能用（Safari 没有目录选择对话框，会改用普通的文件夹选择框）。

## 许可证与声明

代码以 [MIT](LICENSE) 许可证发布。本项目不包含任何游戏资源，与游戏及其作者无关联；使用时请选择你自己的游戏文件。
