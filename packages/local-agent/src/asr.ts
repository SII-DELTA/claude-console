import sdk from "tencentcloud-sdk-nodejs-asr";

const AsrClient = sdk.asr.v20190614.Client;
type Client = InstanceType<typeof AsrClient>;

let client: Client | null = null;

/** Whether Tencent ASR credentials are present (VOICE_SECRET_ID/KEY in env/.env). */
export function asrConfigured(): boolean {
  return !!(process.env.VOICE_SECRET_ID && process.env.VOICE_SECRET_KEY);
}

function getClient(): Client | null {
  const secretId = process.env.VOICE_SECRET_ID;
  const secretKey = process.env.VOICE_SECRET_KEY;
  if (!secretId || !secretKey) return null;
  if (!client) {
    client = new AsrClient({
      credential: { secretId, secretKey },
      region: process.env.VOICE_REGION || "ap-guangzhou",
      profile: { httpProfile: { endpoint: "asr.tencentcloudapi.com", reqTimeout: 30 } },
    });
  }
  return client;
}

/**
 * Transcribe a short audio clip (≤60s) via Tencent 一句话识别 (SentenceRecognition).
 * `audioBase64` is raw base64 (no data: prefix); default format is 16k mono PCM.
 */
export async function transcribe(audioBase64: string, format = "pcm"): Promise<string> {
  const c = getClient();
  if (!c) throw new Error("ASR not configured (set VOICE_SECRET_ID / VOICE_SECRET_KEY)");
  const dataLen = Buffer.from(audioBase64, "base64").length;
  const res = await c.SentenceRecognition({
    EngSerViceType: "16k_zh",
    SourceType: 1,
    VoiceFormat: format,
    Data: audioBase64,
    DataLen: dataLen,
    UsrAudioKey: `web-${dataLen}`,
  });
  return res.Result ?? "";
}
