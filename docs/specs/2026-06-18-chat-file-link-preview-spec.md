# 聊天记录文件链接预览 Spec

- 日期: 2026-06-18
- 状态: 待办(低优先 / backlog)。已定方向:① 1A,② 2A。先记录,暂不实现。
- 背景: Claude 的聊天输出里大量出现文件路径(如 `apps/web/lib/store.ts`、`docs/specs/xxx.md`、`store.ts:367`),目前不可点击,手机上无法查看其内容(也是之前"看文档 404"的真实诉求 —— 应通过点击聊天里的文件链接来预览,而非单独的文档浏览器)。

## 目标

点击聊天消息里出现的文件路径 → 正确解析为真实路径 → 打开预览窗口显示该项目文件内容,手机可读。

## 已定决策

- **① 路径识别范围 = 1A**:只识别**行内代码(反引号)**里像文件路径的文本。判定:含 `/` 或带常见扩展名,可带 `:行号`/`:行:列` 后缀。不扫描普通正文(避免误报)。
- **② 安全边界 = 2A**:仅允许预览**当前会话 cwd 子树内**的文件。相对路径按会话 cwd 解析;绝对路径只要 resolve 后仍在 cwd 内即可;否则拒绝。

## 设计

### 后端(local-agent http-server)

- `GET /files/preview?cwd=<sessionCwd>&path=<clicked>`(鉴权):
  - 解析:`abs = isAbsolute(path) ? path : resolve(cwd, path)`;去掉 `:line` 后缀再解析。
  - **路径穿越防护**:`abs` 必须在 `resolve(cwd)` 子树内,否则 403。
  - 大小上限(如 1MB),超限截断并标记 `truncated`。
  - 二进制识别:图片返回 base64/`kind=image`;其他二进制 `kind=binary` 不返回内容。
  - 返回 `{ path, relPath, kind: "text"|"markdown"|"image"|"binary", content?, truncated, size }`。

### 前端(web)

- `apps/web/components/Markdown.tsx`:在 `code` 渲染器里加路径识别(正则 + 扩展名白名单),命中则渲染为可点击 token;需把当前会话 `cwd` 通过 prop/context 传入 Markdown。
- `api.ts`:`previewFile(cwd, path)`。
- 新增 `apps/web/components/FilePreview.tsx`:覆盖层。
  - `markdown` → 复用现有 Markdown 渲染;`text` → 等宽预格式 + 可选行号、`:line` 命中高亮并滚动到位;`image` → 内联;`binary`/超限 → 占位提示。
  - 顶部显示 relPath、复制路径、关闭。

## 影响范围

- agent: `http-server.ts`(新增 1 路由 + helper)。
- web: `Markdown.tsx`(路径识别 + cwd 传入)、`api.ts`、新增 `FilePreview.tsx`、消息渲染处传 cwd。

## 非目标

- 不做编辑、不做正文(非反引号)扫描、不跨 cwd 越界读取。

## 风险

- 路径误报:严格用"含 / 或带扩展名"+ 扩展名白名单收敛。
- 安全:必须以 `resolve` 后仍在 cwd 子树为唯一放行条件。
- 路径解析歧义:`:line` 后缀、`~`、`./`、`../` 需规范化后再校验。

## 验证

- 手动:点击聊天里的 `docs/...md` / `apps/web/...ts` 能打开预览;越界路径(如 `/etc/passwd`、`../../`)被拒;图片可看;大文件截断提示。
