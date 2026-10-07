![:name](https://count.getloli.com/@AAAA9731-VPicker?theme=asoul&padding=7&offset=0&align=top&scale=1&pixelated=1&darkmode=auto)

# VPicker

在本地读取《Alice in Cradle》的游戏文件，把 PXL 素材导出来、给 SimplePatch 的自定义图片写 PIC 指令，以及把 Spine 动作录成视频。不用启动游戏，读取原游戏资源时不会改动文件。

图片相关的功能（立绘、非立绘图片、自定义图片）全在浏览器里跑，不需要额外的服务；只有导入和重命名要写磁盘，得用 exe 按路径加载。导出 Spine 视频靠本地服务调用 FFmpeg，所以那部分要用单文件程序或自己起本地服务。

## 下载和运行

去 [Releases](../../releases) 下载对应平台的文件：

- **Windows**：`VPicker.exe`，双击运行。它会自己打开浏览器页面，关掉标签页后程序退出。
- **macOS**：Apple 芯片选 `VPicker-macos-arm64.zip`，Intel 选 `VPicker-macos-x64.zip`。解压后在终端运行 `./VPicker`。程序没有 Apple 开发者签名，首次运行被系统拦下的话，执行 `xattr -dr com.apple.quarantine VPicker` 再运行。

exe 启动后会检查 GitHub 上的新版本。Windows 版可以一键下载安装并重启，macOS 版只提示去下载页。Releases 里是已经发布的版本；如果你想用仓库里最新的改动，按下面的方式从源码跑或自己构建。

只跑网页预览：

```
npm install
npm run dev
```

`npm run dev` 只有网页，没有 FFmpeg 服务，所以预览、导出图片都可以，但导出视频不行。要完整的本地服务（包括视频编码）：

```
npm run build
npm start
```

打包单文件程序用 `npm run build:exe`，产物在 `release/`。

## 选择游戏文件夹

页面上的「选择文件夹…」一般选游戏的 `StreamingAssets`。只提取图片的话，选中里面的 `EvImg` 也行；只做动画的话，选 `SpineAnim` 之类的分类文件夹也可以。文件夹直接拖到页面上效果一样。

Windows 的 exe 还能带路径启动：

```
VPicker.exe --dir=D:\Game\AliceInCradle_Data\StreamingAssets
```

也可以把文件夹拖到 exe 上，或者在页面里把路径填进「加载路径」。加载成功过的路径会被记住（Windows 在 `%APPDATA%\VPicker\config.json`），下次不带参数启动时自动填入并加载。

游戏文件只在本机读取。导出视频时，逐帧画面发给本机的 FFmpeg 服务，不会上传到外部服务器。

## 立绘

「立绘」页按角色分标签，点选姿势和表情，中间实时预览，下方会生成对应的 `PIC` 指令，复制走就能贴进事件脚本。反过来也支持：把 `PIC` 指令粘进输入框，会自动切到那条指令对应的姿势和表情。输入框旁边的 `N` 就是游戏里的同名标志。

「批处理」里能一次处理某个表情配所有姿势、或某个姿势配所有表情，可以复制全部指令，也可以下载 ZIP（里面是 PNG 加一份 `pic.txt`）。手头有 `.cmd` / `.txt` 事件脚本时，用下面的「从 cmd 文件里挑 PIC 行」可以把文件里的 PIC 行列出来点选。

## 非立绘图片

事件 CG、UI、小游戏素材、敌人和 NPC 这些 PXL 图片包在「非立绘图片」页。批处理可以按连续序号导出整段帧动画、导出整个图片包，或者按住 Ctrl 点选若干张一起打包成 ZIP。

立绘和非立绘页面的预览操作一致：滚轮缩放、拖动平移、双击复位。「复制图片」和「保存图片」都是 1:1 原始分辨率，背景可以透明，也可以选一个纯色。

## 自定义图片（配合 SimplePatch）

如果加载的文件夹里有 `SimplePatch_pic`（[SimplePatch](https://github.com/AAAA9731/SimplePatch) 的 PicLoad 补丁读取自定义 PNG 的文件夹），页面会多出一个「自定义图片」页。

- 左边列出文件夹里的 PNG，点选后放进 16:9 的游戏画面预览里摆位置。拖动图片改的是 `PIC_MV` 坐标；缩放只能从游戏真正支持的几档里选（`h` 标志，以及 `PIC_MVA ZOOM2/3/4` 对应的倍率）。
- 窗口分辨率可以按游戏设置里的 15 种来选，窗口按该分辨率的真实像素大小显示，方便跟游戏窗口对着比位置。
- 面板里填好 id、PIC 层和额外参数，下面实时生成 `PIC_LOAD` / `PIC` / `PIC_MV` / `PIC_MVA`。可以复制这两行、只复制 `PIC_LOAD`，或者一次复制全部图片的 `PIC_LOAD`。
- 把 PNG 拖进页面就能导入到 `SimplePatch_pic`：程序先分配一个名字，然后打开重命名框；在缩略图上长按也能重命名。导入和重命名会写文件，所以要用 exe（或本地服务）按路径加载文件夹；浏览器自己的文件夹选择框是只读的。

## Spine 动画

这个页面每次进入都要先看 3 秒使用须知并手动确认，切到后台的时间不计入。

这里的资源大多含 NSFW / 成人内容，动作、皮肤和部件组合不同，内容也可能不同。须知里会直接提醒，不做逐项分类或过滤；请在合适的环境中使用，预览、导出和发布前自行审查。

- 从 `SpineAnim`、`SpineAnimEn`、`SpineAnimEv`、`Fatal` 里读取资源，可以按分类筛选或按名字搜索。皮肤以组合使用：先选组合预设，需要微调时展开「调整组合部件」，每组只选一种版本，基础皮肤和所选部件一起预览、一起导出。
- 已把这版游戏配置里的基础皮肤与叠加分组整理成预设。没有配置预设的资源，按部件结构补齐初始组合；这部分是推断，可以手动调整。预设只处理皮肤拼装，游戏里的状态变化、随机选择和多轨动画混合还没复现。
- 预览使用独立实现的 Spine 4.1 数据兼容渲染器和 WebGL 2（浏览器自带能力），没有集成官方 Spine Runtime，也不需要装 Spine 编辑器。支持播放、时间轴、缩放和平移。
- 导出时可以设起始动画时间、播放速率、视频时长（最长 120 秒）和帧率，逐帧编码成 MP4 或 WebM；可以循环播放，也可以在动作结束后停在末帧，导出中途能取消。
- 单文件程序里已经内置 FFmpeg：第一次用到视频功能时把它解压到系统临时目录，退出时清理，所以分发时仍然只有一个程序文件。

有几点得说清楚：这里只渲染你选中的动作和皮肤，游戏脚本里的动作混合、背景、音效和特效都不会复现。特殊骨骼变换等细节是按格式推导实现的，最终画面还得你自己跟游戏核对。兼容的细节和当前限制写在 [实现说明](src/spine/INDEPENDENT.md) 里。

这个功能只输出视频，不提供 Spine 工程、骨骼数据或图集文件的下载。

游戏和素材的版权归 NanameHacha。做二创和发布时请遵守[素材使用协议](https://docs.nanamehacha.dev/en/alice_in_cradle/license/the_use_of_game_assets)；本程序不包含任何游戏素材。

## 开发

```
npm test           # 依赖游戏数据的用例需要 SA_DIR（StreamingAssets 路径），没设置就自动跳过
npm run build      # 构建网页到 dist/
npm run build:exe  # 打包单文件程序到 release/（Windows 出 exe，macOS 出 zip）
```

打包需要静态 FFmpeg，并且要带 `libx264` 和 `libvpx-vp9` 编码器，不能是 `nonfree` 的构建。想用自己的 FFmpeg，用 `FFMPEG_PATH` 指定二进制，同时必须用 `FFMPEG_NOTICE_PATH` 提供与该二进制匹配的许可证和源码信息。

推送到 `main` 会触发 CI，在 Windows 和 macOS（arm64 / x64）上测试、构建并做启动冒烟测试；推 `v*` 标签会把三个平台的程序发布到 Releases。

网页在 Chrome、Edge、Safari 等现代浏览器上都能用。Safari 没有目录选择对话框，会改用普通的文件夹选择框。

## 许可证

VPicker 的源码以 [MIT](LICENSE) 发布。本项目与游戏及其作者无关联，也不包含游戏资源。

Spine 兼容模块根据公开格式说明和输入数据独立实现，不包含官方 Spine Runtime；官方对独立实现的许可说明见 [Spine 官方答复](https://esotericsoftware.com/forum/d/17841-licence-for-a-new-runtime-written-from-scratch)。

内置的静态 FFmpeg 以独立子进程方式调用，采用 GPLv3 或更新版本，和项目本身的 MIT 是分开的两件事。构建时会一并带上许可证、二进制校验值、上游版本和源码来源，页面里的[组件许可](public/licenses/index.html)可以直接查看。对外分发时，需要提供与该 FFmpeg 二进制及其依赖相匹配的完整对应源码和构建信息，遵守 [FFmpeg 分发要求](https://ffmpeg.org/legal.html)。
