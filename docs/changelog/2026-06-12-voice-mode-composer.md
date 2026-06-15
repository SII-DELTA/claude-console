# Change Log — 语音模式输入（长按说话）

日期: 2026-06-12

## 背景

在已有「文本模式麦克风按钮（点击切换录音）」基础上，新增一个可切换的**语音模式**：底部输入框替换为一个大的「长按说话」按钮，长按录音、松开转写，类似 ChatGPT 通话/微信语音的交互。左右两侧保留图片、发送等操作按钮。

## 改动文件

- `apps/web/components/Composer.tsx`
  - 新增 `voiceMode` 本地状态，持久化到 `localStorage["mac.voiceMode"]`（不改动正被并行会话编辑的全局 store）。
  - 新增输入模式切换按钮 `ModeToggle`（键盘图标 ↔ 声波图标），两种模式均在最左侧。
  - 把录音逻辑拆为 `startRecording()` / `stopAndTranscribe()`：
    - 文本模式麦克风：点击切换（`micClick`）。
    - 语音模式大按钮：按下开始、松开结束（`onHoldStart` / `onHoldEnd`，用 Pointer 事件兼容触屏与鼠标）。
  - 语音模式布局：顶部右侧「切回键盘」，下方 `[图片] [大圆形「长按开始说话」] [发送/中断]`；圆形上方为**可编辑**的转写文本框（可改字/增删/清空），按 Enter 或点发送才发送。
  - （LLM 纠错润色：本轮按用户决定暂不做。）
  - 大圆形按钮：`h-40 w-40` 圆形 + 珊瑚色（accent #D97757）光圈（box-shadow），录音时光圈加亮并叠加 `animate-ping` 外环；中心为珊瑚色声波（`Bars`，录音时 pulse）+ 文案。
  - 录音中显示「松开结束」，转写中显示 spinner + 「转写中…」，空闲「长按开始说话」。
  - 大按钮加 `touchAction:none` / `userSelect:none` / `onContextMenu preventDefault`，避免移动端长按触发选中或上下文菜单。

## 核心变更

- 复用现有 `PcmRecorder`（16k mono PCM）与 `/asr`（腾讯一句话识别）链路，仅改交互层。
- 转写结果追加进待发送文本，**不自动发送**——保留右侧发送按钮显式确认（与「左右保留操作按钮」一致）。

## 影响范围

- 仅前端 Composer 组件；后端 `/asr`、`asr.ts`、`recorder.ts` 未改。
- 非安全上下文（明文 http）下大按钮按下时提示「需 HTTPS 或 localhost」，与文本模式一致。

## 验证结果

- `pnpm exec tsc --noEmit`（web）通过，无类型错误。
- `pnpm test`（web）14 测试全绿。
