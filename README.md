# VPicker

立绘 VP 选择器

Alice in Cradle 游戏内 F7 的 vp 立绘差分选择器的外部版（纯浏览器，不需要运行游戏）。

- 点姿势、点表情 → 实时预览，并给出对应的 `PIC` 指令
- 粘贴 / 输入 `PIC` 指令 → 自动切换到对应的姿势和表情
- 复制 / 保存当前立绘为 PNG（原始分辨率，背景可选透明或自选纯色）
- 批处理：「当前表情 × 所有姿势」或「当前姿势 × 所有表情」，可一键复制全部 PIC 指令，或下载全部图片（ZIP，附 pic.txt）
- 可打开 cmd 文件，列出其中所有 PIC 行，点一行即定位

## 使用

```
npm install
npm run dev      # 打开页面后点“选择文件夹…”，选 StreamingAssets（或其中的 EvImg）
npm run build    # 产物在 dist/，是纯静态文件（JavaScript，无需 TypeScript）
npm test         # 需要本机有游戏；用环境变量 SA_DIR 指向 StreamingAssets
```

文件只在本地读取，不会上传。解包在浏览器内完成（UnityFS → LZMA/LZ4 → TextAsset/Texture2D → Crunch → DXT5）。
选择文件夹需要 Chrome / Edge；其他浏览器会退回到普通文件夹选择框，也可以直接把文件夹拖进页面。

## 结构

- `src/unity/` UnityFS、SerializedFile、LZ4、LZMA、贴图解码
- `src/pxl/reader.js` PXL 二进制解析（移植自 pixelliner.dll 的 PxlCharacter）
- `src/pxl/person.js` 姿势/表情构建（移植自 EvPerson.initPxEmot、EvEmotVisibility）
- `src/pic.js` PIC 指令生成与解析（对应 EvDebugger 的 clickFaceEmotion / executeLiRCommand）
- `src/render.js` 图层合成（对应 EvEmotVisibility.drawTo）
- `src/batch.js` 批处理展开与 ZIP 写入

开发时设置 `AIC_SA_DIR` 后访问 `/?auto=1` 可免选文件夹（仅 dev 服务器，不进入构建产物）。

## 打包成 exe

```
npm run build:exe    # 产物：release/VPicker.exe（约 89 MB，单文件，不需要安装 Node）
```

双击 exe：弹出命令行窗口，自动用默认浏览器打开页面；窗口里会显示服务状态，以及页面上的操作反馈
（解包哪个角色、出错信息等）。关闭浏览器标签页 5 秒后窗口自动退出（刷新页面不会误退出），也可以按 Ctrl+C。

可选参数：`--no-open` 不自动打开浏览器；`--port=8080` 指定端口（默认 5173，被占用时自动顺延）。
网页资源以 Node SEA 方式嵌在 exe 内，服务器代码在 `server/main.js`，只监听 127.0.0.1。

## 开发与 CI

- `npm test`：纯逻辑测试默认运行；依赖游戏数据的测试需要设置 `SA_DIR` 指向游戏的 `StreamingAssets` 文件夹，否则自动跳过。
- GitHub Actions（`.github/workflows/`）：
  - `ci.yml`：每次推送到 main / 提交 PR 时运行测试、构建网页、打包 exe，并对 exe 做一次启动冒烟测试；exe 作为构建产物上传。
  - `release.yml`：推送 `v*` 标签（如 `git tag v1.0.0 && git push --tags`）时自动构建并把 `VPicker.exe` 发布到 Releases。
- 本仓库不包含任何游戏资源，使用时在页面里选择你自己的游戏文件夹。
