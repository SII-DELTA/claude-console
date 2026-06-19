"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { ClaudeImage } from "@mac/shared";
import { useAppStore, describeError } from "../lib/store";
import { PcmRecorder } from "../lib/recorder";
import { ImageThumb } from "./ImageThumb";

interface PickedImage extends ClaudeImage {
  previewUrl: string;
}

const VOICE_MODE_KEY = "mac.voiceMode";
function loadVoiceMode(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(VOICE_MODE_KEY) === "1";
}

export function Composer({
  onSend,
  onInterrupt,
  streaming,
  disabled,
  placeholder,
  prefill,
  onSendToVscode,
}: {
  onSend: (text: string, images?: ClaudeImage[]) => void | boolean | Promise<void | boolean>;
  onInterrupt: () => void;
  streaming: boolean;
  disabled?: boolean;
  placeholder?: string;
  /** External text to drop into the input. Bump `nonce` to re-trigger even with the same text. */
  prefill?: { text: string; nonce: number };
  /** when set, shows a "→VSCode" button that pushes the current text to the desktop session.
   * Returns whether it succeeded so the draft can be restored on failure. */
  onSendToVscode?: (text: string) => Promise<{ ok: boolean }> | void;
}) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<PickedImage[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Drop external text into the input and focus it, cursor at end. Runs on nonce change.
  useEffect(() => {
    if (!prefill || prefill.nonce === 0) return;
    setText(prefill.text);
    // wait a frame so the textarea (voice-mode renders it only when text is non-empty) is mounted
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      const end = el.value.length;
      el.setSelectionRange(end, end);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill?.nonce]);

  const api = useAppStore((s) => s.api);
  const setError = useAppStore((s) => s.setError);
  const enterBehavior = useAppStore((s) => s.enterBehavior);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [voiceHint, setVoiceHint] = useState(false);
  const [voiceMode, setVoiceModeState] = useState(loadVoiceMode);
  const recorderRef = useRef<PcmRecorder | null>(null);
  // guard async transcription callbacks from setting state after unmount (switch session/tab)
  const mounted = useRef(true);
  useEffect(() => () => void (mounted.current = false), []);

  // Auto-grow the textarea with its content (WeChat-style); CSS max-height caps it then scrolls.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text, voiceMode]);

  function toggleVoiceMode() {
    const v = !voiceMode;
    setVoiceModeState(v);
    if (typeof window !== "undefined") window.localStorage.setItem(VOICE_MODE_KEY, v ? "1" : "0");
  }

  function submit() {
    const t = text.trim();
    if ((!t && images.length === 0) || disabled) return;
    const snapText = text;
    const snapImages = images;
    // Optimistically clear (keeps the instant feel + the optimistic bubble). If the
    // send reports failure, restore the draft so nothing the user typed is lost.
    Promise.resolve(
      onSend(
        t || "(见图片)",
        images.length ? images.map(({ mediaType, dataBase64 }) => ({ mediaType, dataBase64 })) : undefined,
      ),
    )
      .then((ok) => {
        if (ok === false) {
          setText(snapText);
          setImages(snapImages);
          requestAnimationFrame(() => textareaRef.current?.focus());
        }
      })
      .catch(() => {
        setText(snapText);
        setImages(snapImages);
      });
    setText("");
    setImages([]);
  }

  const canRecord = () =>
    typeof window !== "undefined" && window.isSecureContext && !!navigator.mediaDevices?.getUserMedia;

  async function startRecording(): Promise<boolean> {
    if (!canRecord()) {
      setVoiceHint(true);
      return false;
    }
    setVoiceHint(false);
    try {
      recorderRef.current = new PcmRecorder();
      await recorderRef.current.start();
      setRecording(true);
      return true;
    } catch {
      recorderRef.current = null;
      setVoiceHint(true);
      return false;
    }
  }

  async function stopAndTranscribe() {
    if (!recorderRef.current) return;
    setRecording(false);
    setTranscribing(true);
    try {
      const b64 = await recorderRef.current.stop();
      const { text: t } = await api!.asr(b64);
      if (!mounted.current) return; // bailed out of this composer mid-transcribe
      if (t) setText((prev) => (prev.trim() ? `${prev} ${t}` : t));
      else setError("未识别到语音，请重试");
    } catch (e) {
      // surface the failure so it isn't silently swallowed; backend sends a readable message
      if (mounted.current) setError(`语音转写失败：${describeError(e)}`);
    } finally {
      if (mounted.current) setTranscribing(false);
      recorderRef.current = null;
    }
  }

  // text-mode mic: click to toggle
  function micClick() {
    if (recording) void stopAndTranscribe();
    else void startRecording();
  }

  // voice-mode big button: press-and-hold
  function onHoldStart(e: PointerEvent) {
    e.preventDefault();
    if (!recording && !transcribing && !disabled) void startRecording();
  }
  function onHoldEnd(e: PointerEvent) {
    e.preventDefault();
    if (recording) void stopAndTranscribe();
  }

  async function onFiles(files: FileList | null) {
    if (!files) return;
    const picked: PickedImage[] = [];
    for (const f of Array.from(files).slice(0, 8)) {
      if (!f.type.startsWith("image/")) continue;
      const dataBase64 = await fileToBase64(f);
      picked.push({ mediaType: f.type, dataBase64, previewUrl: URL.createObjectURL(f) });
    }
    setImages((prev) => [...prev, ...picked].slice(0, 8));
    if (fileRef.current) fileRef.current.value = "";
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    // Decide whether Enter sends or inserts a newline.
    let send: boolean;
    if (enterBehavior === "send") send = true;
    else if (enterBehavior === "newline") send = false;
    else {
      // auto: touch devices insert a newline (send via the button); else Enter sends.
      const coarse =
        typeof window !== "undefined" && !!window.matchMedia?.("(pointer: coarse)").matches;
      send = !coarse;
    }
    if (send) {
      e.preventDefault();
      submit();
    }
  }

  const ModeToggle = (
    <button
      onClick={toggleVoiceMode}
      disabled={disabled}
      className="btn-ghost shrink-0 !px-2.5 !py-2 text-ink-faint hover:text-ink"
      title={voiceMode ? "切换键盘输入" : "切换语音模式"}
      aria-label="切换输入模式"
    >
      {voiceMode ? (
        <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="2" y="6" width="20" height="12" rx="2" />
          <line x1="6" y1="10" x2="6" y2="10" /><line x1="10" y1="10" x2="10" y2="10" /><line x1="14" y1="10" x2="14" y2="10" /><line x1="8" y1="14" x2="16" y2="14" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <line x1="5" y1="9" x2="5" y2="15" /><line x1="9" y1="6" x2="9" y2="18" /><line x1="13" y1="4" x2="13" y2="20" /><line x1="17" y1="8" x2="17" y2="16" /><line x1="21" y1="10" x2="21" y2="14" />
        </svg>
      )}
    </button>
  );

  const ImageBtn = (
    <button
      onClick={() => fileRef.current?.click()}
      disabled={disabled}
      className="btn-ghost shrink-0 !px-2.5 !py-2 text-ink-faint hover:text-ink"
      title="添加图片"
      aria-label="添加图片"
    >
      <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="8.5" cy="8.5" r="1.5" />
        <path d="M21 15l-5-5L5 21" />
      </svg>
    </button>
  );

  const VscodeBtn = onSendToVscode ? (
    <button
      onClick={() => {
        const t = text.trim();
        if (!t || disabled) return;
        setText("");
        void Promise.resolve(onSendToVscode(t)).then((r) => {
          if (r && !r.ok) setText(t); // failed (e.g. no Accessibility perm) → restore the draft
        });
      }}
      disabled={disabled || !text.trim()}
      className="btn-ghost shrink-0 !px-2 !py-2 text-ink-faint hover:text-accent disabled:opacity-40"
      title="发到桌面 VSCode 会话"
      aria-label="发到 VSCode"
    >
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" />
      </svg>
    </button>
  ) : null;

  const SendOrStop = streaming ? (
    <button onClick={onInterrupt} className="btn-ghost shrink-0 !px-2.5 !py-2 text-danger" title="中断" aria-label="中断">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
        <rect x="6" y="6" width="12" height="12" rx="2" />
      </svg>
    </button>
  ) : (
    <button
      onClick={submit}
      disabled={disabled || (!text.trim() && images.length === 0)}
      className="btn shrink-0 !px-2.5 !py-2"
      title="发送"
      aria-label="发送"
    >
      <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <line x1="12" y1="20" x2="12" y2="5" />
        <polyline points="6 11 12 5 18 11" />
      </svg>
    </button>
  );

  return (
    <div className="shrink-0 bg-bg-alt/80 px-3 pt-2 pb-safe backdrop-blur">
      <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => void onFiles(e.target.files)} />
      {images.length > 0 && (
        <div className="mx-auto mb-2 flex max-w-3xl gap-2 overflow-x-auto scroll-thin">
          {images.map((img, i) => (
            <div key={i} className="relative shrink-0">
              <ImageThumb src={img.previewUrl} className="h-14 w-14 rounded-lg border border-line object-cover" />
              <button
                onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
                className="absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full bg-bg-raised text-[11px] text-ink-dim ring-1 ring-line"
                aria-label="移除图片"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {voiceMode ? (
        <div className="mx-auto max-w-3xl pb-2">
          {/* top bar: switch back to keyboard */}
          <div className="mb-1 flex justify-end">{ModeToggle}</div>
          {/* editable transcript (what will be sent) */}
          {text.trim() && (
            <div className="mb-3 flex items-start gap-2 rounded-xl border border-line bg-bg-raised px-3 py-2">
              <textarea
                ref={textareaRef}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={onKeyDown}
                rows={1}
                disabled={disabled}
                aria-label="转写文本，可编辑"
                className="max-h-32 min-w-0 flex-1 resize-none bg-transparent text-[14px] text-ink outline-none scroll-thin disabled:opacity-50"
                style={{ minHeight: "1.5rem" }}
              />
              <button onClick={() => setText("")} className="shrink-0 text-[12px] text-ink-faint hover:text-ink" aria-label="清空">
                ✕
              </button>
            </div>
          )}
          {/* big circular hold-to-talk, flanked by image (left) and send (right) */}
          <div className="flex items-center justify-center gap-5">
            {ImageBtn}
            <button
              onPointerDown={onHoldStart}
              onPointerUp={onHoldEnd}
              onPointerCancel={onHoldEnd}
              onPointerLeave={onHoldEnd}
              onContextMenu={(e) => e.preventDefault()}
              disabled={disabled || transcribing}
              style={{ touchAction: "none", userSelect: "none" }}
              className={`relative grid h-40 w-40 select-none place-items-center rounded-full border transition-all ${
                recording
                  ? "border-accent bg-accent/15 shadow-[0_0_60px_-4px_rgba(217,119,87,0.75)]"
                  : "border-accent/30 bg-accent/[0.06] shadow-[0_0_40px_-10px_rgba(217,119,87,0.5)] active:scale-95"
              }`}
            >
              {/* pulsing outer ring while recording */}
              {recording && (
                <span className="pointer-events-none absolute inset-0 animate-ping rounded-full border border-accent/50" />
              )}
              <span className="pointer-events-none absolute inset-3 rounded-full border border-accent/15" />
              <div className="flex flex-col items-center gap-2.5">
                {transcribing ? (
                  <span className="h-7 w-7 animate-spin rounded-full border-2 border-accent border-t-transparent" />
                ) : (
                  <Bars active={recording} />
                )}
                <span className={`text-[13px] font-medium ${recording ? "text-accent" : "text-ink-dim"}`}>
                  {transcribing ? "转写中…" : recording ? "松开结束" : "长按开始说话"}
                </span>
              </div>
            </button>
            {!streaming && VscodeBtn}
            {SendOrStop}
          </div>
        </div>
      ) : (
        <div className="mx-auto flex max-w-3xl items-end gap-2 rounded-2xl border border-line bg-bg-raised px-3 py-2">
          {ModeToggle}
          {ImageBtn}
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            disabled={disabled}
            placeholder={
              recording ? "正在录音… 再点麦克风结束" : transcribing ? "转写中…" : placeholder ?? "给 Claude 下达指令…"
            }
            className="max-h-40 flex-1 resize-none bg-transparent py-1.5 text-[15px] text-ink outline-none placeholder:text-ink-faint scroll-thin disabled:opacity-50"
            style={{ minHeight: "2rem" }}
          />
          <button
            onClick={micClick}
            disabled={disabled || transcribing}
            className={`btn-ghost shrink-0 !px-2.5 !py-2 ${recording ? "text-danger" : "text-ink-faint hover:text-ink"}`}
            title={recording ? "停止并转写" : "语音输入"}
            aria-label="语音输入"
          >
            {transcribing ? (
              <span className="inline-block h-[17px] w-[17px] animate-spin rounded-full border-2 border-ink-faint border-t-transparent" />
            ) : (
              <span className={recording ? "animate-pulse" : ""}>
                <MicGlyph />
              </span>
            )}
          </button>
          {!streaming && VscodeBtn}
          {SendOrStop}
        </div>
      )}

      {voiceHint && (
        <p className="mx-auto mt-1 max-w-3xl text-center text-[11px] text-ink-faint">
          语音输入需 HTTPS 或 localhost（且允许麦克风权限）
        </p>
      )}
    </div>
  );
}

function MicGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="2" width="6" height="11" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0" />
      <line x1="12" y1="19" x2="12" y2="22" />
    </svg>
  );
}

/** Coral waveform glyph; bars animate while `active`. */
function Bars({ active }: { active: boolean }) {
  const h = [14, 26, 20, 30, 18];
  return (
    <span className="flex h-8 items-center gap-1" aria-hidden="true">
      {h.map((height, i) => (
        <span
          key={i}
          className={`inline-block w-[4px] rounded-full bg-accent ${active ? "animate-pulse" : ""}`}
          style={{ height, animationDelay: `${i * 110}ms` }}
        />
      ))}
    </span>
  );
}

/** Read a File to raw base64 (no data: prefix). */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
