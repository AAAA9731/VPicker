# Spine 4.1 独立兼容渲染

动画计算模块在独立上下文中实现，没有引入官方 Spine Runtime、其移植版本或源码。格式行为依据游戏导出的 JSON / atlas 数据，以及公开格式文档中的规则推导。这里不包含游戏素材；调查期间产生的素材副本及诊断脚本已清理。

公开参考：

- [JSON 格式](https://esotericsoftware.com/spine-json-format)
- [Atlas 格式](https://esotericsoftware.com/spine-atlas-format)
- [骨骼继承](https://esotericsoftware.com/spine-bones#Transform-inheritance)
- [官方关于独立实现的许可答复](https://esotericsoftware.com/forum/d/17841-licence-for-a-new-runtime-written-from-scratch)

实现模块：

| 文件 | 职责 |
| --- | --- |
| atlas.js | 图集描述、旋转和裁剪后的 UV 映射 |
| pose.js | 骨骼变换、蒙皮、变形及动作时间轴采样 |
| resources.js | 本地 Unity 资源包读取和贴图解码 |
| webgl.js | 通用纹理三角形绘制与 RGBA 帧读取 |
| timing.js | 视频帧序号到动画源时间的映射 |
| controller.js | 资源选择、皮肤组合、预览及视频任务 |
| skin-combinations.js / skin-presets.json | 皮肤组合预设、互斥部件分组及无预设资源的初始拼装 |

createRig(json, atlas) 预处理数据。rig.skinNames 提供皮肤名称；rig.animations 提供动作名称和时长。

samplePose(rig, animationName, sourceTime, skinName) 按明确的源时间生成单个动作的画面，animationName = null 表示初始姿态。皮肤参数可为名称或名称数组，后面的皮肤优先，缺少的附件回退到 default 皮肤。空数组表示只使用 default。

界面按组合传入皮肤数组，不再默认把单个部件当成完整皮肤。27 份资源的组合预设由游戏 body_noel 配置中的皮肤名称、叠加分组和常态/回退候选整理得到；同组只选一项，default 作为基础。配置事实通过读取文本与游戏侧 UIPictureBodySpine 的皮肤选择调用确认，未读取或反编译 Spine Runtime 实现，也未将游戏代码复制进项目。无预设资源按皮肤名称分组、初始附件覆盖补齐组合，这部分只是推断。预设不会模拟游戏状态条件、随机候选或多轨动画；尚未做画面对照。

进入页面时的三秒须知明确提示：资源大多含 NSFW / 成人内容，动作与皮肤组合会影响内容。程序不逐项分类或过滤，由使用者审查预览、导出及发布的内容。

输出包含绘制顺序、世界坐标、归一化纹理 UV、三角形索引、颜色及混合模式。世界坐标 Y 向上，贴图坐标从左上角开始。UV 与索引是共享的预处理数据，调用方不得修改。采样复用每个 rig 的内部临时空间，不支持对同一 rig 重入调用。

已实现区域附件、加权与非加权网格、关联网格、附件切换、颜色、绘制顺序、变形、序列附件，以及线性、阶梯和逐分量贝塞尔曲线。遇到不支持的数据会报错。

视频第 i 帧的动画源时间为 start + i * speed / fps。循环时按动作时长取余，关闭循环时停在动作末帧。视频帧数为 ceil(duration * fps)，实际视频时长为帧数除以帧率。WebGL 帧逐帧送入本地 FFmpeg，编码不依赖浏览器实时播放速度。

## 坐标系与裁剪

- 图集 `bounds` 的 width/height 是未旋转的逻辑尺寸；rotate 90/270 时页面实际占用区域是 height x width，`region.uv` 的 u1/v1 按该占用区域（footprint）计算。
- `offsets` 的 ox/oy 是从左侧与底部裁掉的透明像素（页面像素），origW/origH 是原图尺寸，顶部裁剪 = origH - packedH - oy。解析后 offsetX/offsetY/originalWidth/originalHeight 统一换算为逻辑单位（除以页面 scale）；`bounds` 保留页面像素，凡与上述值混算处（例如 region.width / scale）都先换算到逻辑单位。
- regionUvAt 的 (u, v) 定义在“裁剪后区域”的自身坐标系：原点在裁剪矩形左下角，v 向上，按裁剪后尺寸归一化；区域四边形（恰好覆盖裁剪矩形）直接使用该契约，超出 [0, 1] 不裁剪。
- 网格 JSON 的 `uvs` 定义在“未裁剪原图”的坐标系，原点在左上角，v 向下，与 regionUvAt 不是同一空间。mapMeshUvs 先换算到裁剪区域坐标（u = (mu * originalWidth - offsetX) / packedWidth，v = ((1 - mv) * originalHeight - offsetY) / packedHeight，packed 尺寸按页面 scale 换算为同一逻辑单位），再交给 regionUvAt；关联网格复用同一函数，越界值不裁剪。
- 区域附件几何：attachment width/height 与原始尺寸不同时，裁剪位置与裁剪后尺寸都按 width/originalWidth、height/originalHeight 等比缩放；attachment 的 scaleX/scaleY 作用于局部坐标轴，先缩放后旋转（M = R * S）。

## 当前限制

- 不复现游戏脚本中的动作混合、音效、背景或特效。
- 未实现 IK、路径、变换约束、裁剪附件及双色着色；调查的这批数据未使用这些功能。
- 特殊骨骼继承、反射、非均匀缩放与剪切的部分语义由数学推导得到，尚未与游戏画面逐帧对照。少量非单调时间曲线及序列边界也需要人工核对。
- 初始姿态边界与 JSON 记录相符，只能证明部分几何结果，不能证明 UV、动画或整体画面正确。边界不符也不能直接归因于编辑器皮肤状态。
- 本轮修正了图集 UV 占用区域、网格 UV 空间换算、区域附件裁剪缩放与缩放顺序。测试源码中的相关期望值已同步更新，未执行。按用户要求，停止自动测试与画面对照；修正后的版本仅核对源码并通过项目脚本构建 exe，实际效果由用户测试。

VPicker 代码采用项目的 MIT 许可证。FFmpeg 是独立的 GPL 子进程，许可和构建来源随程序另行附带。以上记录说明代码来源与实现范围，不提供法律或视觉一致性的保证。
