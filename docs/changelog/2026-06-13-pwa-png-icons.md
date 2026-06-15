# Change Log — 修复 PWA 桌面图标显示大写字母 C

日期: 2026-06-13

## 背景

安装 PWA 后，桌面/程序坞图标不是 `favicon.svg` 的 Claude logo，而是一个珊瑚底大写 **C**。

根因：浏览器标签页 favicon 可用 SVG，但**已安装 PWA 的图标取自 `manifest.icons`，桌面端 Chrome 不支持 manifest 里的 SVG 图标**，找不到可用 PNG 时就用 `short_name`（“Claude”）首字母在 `theme_color`(#D97757) 上自动生成占位图——即那个大写 C。`apple-touch-icon` 同样指向 SVG，iOS 主屏也会回退。

## 改动文件

- `apps/web/public/icon-192.png` / `icon-512.png`（新增，any）
- `apps/web/public/icon-maskable-512.png`（新增，maskable，白底 + ~13% 安全边距，防安卓自适应裁切）
- `apps/web/public/apple-touch-icon.png`（新增，180×180，iOS 主屏）
  - 均由 `public/favicon.svg` 经 `qlmanage`(SVG→PNG) + `sips`(精确缩放/补方) 生成。
- `apps/web/public/manifest.webmanifest`：`icons` 改为 PNG（192/512 any + 512 maskable），保留 SVG 作为补充；`version` 1.1.0 → 1.2.0。
- `apps/web/app/layout.tsx`：`icons.icon` 改为 SVG + PNG 数组（标签页用 SVG，PWA 用 PNG）；`apple` 与 `startupImage` 指向 PNG；manifest 查询串 bump 到 `?v=1.2.0` 强制刷新。

## 核心变更

- 为 PWA/iOS 安装图标提供 PNG（这是各端安装图标的硬要求），消除字母占位图回退。

## 影响范围

- 仅前端静态资源与图标元数据；功能逻辑无改动。
- 已安装的用户需重新安装或等浏览器刷新 manifest（version/查询串已 bump）。

## 追加修复（Safari/iOS 兼容）

- 用户实际用 **Safari「添加到程序坞/主屏」**，该入口取 `apple-touch-icon`。
- qlmanage 生成的 PNG 带 alpha 通道（`hasAlpha: yes`）。Apple 要求 touch icon **不带透明**，否则 iOS 可能丢黑底或弃用回退占位。
- 用 PIL 把 4 个 PNG 全部 `alpha_composite` 到纯白底并存为 RGB（无 alpha），复核 `hasAlpha: no`。
- 提醒：Safari 站点图标缓存顽固，需移除已添加的 App + 清该站点 Website Data + 重启 Safari 后重新添加才会刷新。

## 验证结果

- `make web`（生产构建）通过。
- `<head>` 输出：`rel=icon` SVG + 192/512 PNG，`apple-touch-icon` 为 PNG。
- 各 PNG 与 manifest 本地均 200；icon-512 / maskable 实际渲染确认为 Claude logo（非字母 C）。
