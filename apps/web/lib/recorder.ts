/**
 * Records microphone audio and yields raw 16 kHz mono PCM (base64) — the format
 * Tencent 一句话识别 accepts natively. Needs a secure context (https/localhost).
 */
export class PcmRecorder {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private chunks: Float32Array[] = [];
  private srcRate = 16000;

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // Chrome honors the 16k hint (no resample needed); Safari may ignore it.
    this.ctx = new AudioContext({ sampleRate: 16000 });
    this.srcRate = this.ctx.sampleRate;
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.processor = this.ctx.createScriptProcessor(4096, 1, 1);
    this.chunks = [];
    this.processor.onaudioprocess = (e) => {
      this.chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    };
    // route through a muted gain so we don't echo the mic to the speakers
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    this.source.connect(this.processor);
    this.processor.connect(mute);
    mute.connect(this.ctx.destination);
  }

  /** Stop recording and return base64 of 16k mono PCM (s16le). */
  async stop(): Promise<string> {
    this.processor?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    try {
      await this.ctx?.close();
    } catch {
      /* noop */
    }
    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    const flat = new Float32Array(total);
    let off = 0;
    for (const c of this.chunks) {
      flat.set(c, off);
      off += c.length;
    }
    this.chunks = [];
    const pcm = toPcm16(flat, this.srcRate, 16000);
    return base64FromBytes(new Uint8Array(pcm.buffer));
  }
}

/** Downsample (linear) to targetRate and convert float[-1,1] → int16. */
function toPcm16(input: Float32Array, srcRate: number, targetRate: number): Int16Array {
  const ratio = srcRate / targetRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const idx = i * ratio;
    const lo = Math.floor(idx);
    const hi = Math.min(lo + 1, input.length - 1);
    const frac = idx - lo;
    const s = input[lo]! * (1 - frac) + input[hi]! * frac;
    out[i] = Math.max(-1, Math.min(1, s)) * 0x7fff;
  }
  return out;
}

function base64FromBytes(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}
