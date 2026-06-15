# 自建 FunASR 语音识别（替代腾讯云）

用 [Fun-ASR-Nano-2512](https://huggingface.co/FunAudioLLM/Fun-ASR-Nano-2512) 自建一句话识别服务，
替代当前 [`packages/local-agent/src/asr.ts`](../../packages/local-agent/src/asr.ts) 调用的腾讯云「一句话识别」。

## 模型选择

| 模型 | 特点 | 适用 |
| --- | --- | --- |
| **Fun-ASR-Nano-2512**（本目录采用） | LLM-based（SenseVoice encoder + Qwen3-0.6B 解码器），31 语言、标点、ITN、热词，准确率最高但较重 | GPU 部署、追求准确率 |
| SenseVoiceSmall | 非自回归、快、多语言、自带标点/情感，~900MB | CPU 也能跑、追求速度 |
| Paraformer-zh | 经典纯中文 + VAD + 标点 | 纯中文、成熟稳定 |

> ⚠️ Fun-ASR-Nano **不能**用 `pip install funasr` 直接跑，stock funasr 会报
> `FunASRNano is not registered`。故 Dockerfile 改为 clone 官方专用仓库
> [FunAudioLLM/Fun-ASR](https://github.com/FunAudioLLM/Fun-ASR) 并装其 `requirements.txt`。

## 前置

- Linux + NVIDIA 驱动 + [nvidia-container-toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)（`docker run --gpus` 必需）。
- macOS 的 Docker Desktop 无法透传 GPU，本镜像只能跑在带 N 卡的 Linux 机器上。

## 构建与运行

```bash
# 构建
docker build -t claude-console-asr ./deploy/funasr

# 运行（首次启动从 HuggingFace 下载权重到挂载卷，持久化）
docker run -d --name asr --gpus all -p 7346:7346 \
  -v funasr-cache:/root/.cache/huggingface \
  claude-console-asr

# 自检
curl http://127.0.0.1:7346/health
# {"ok":true,"model":"FunAudioLLM/Fun-ASR-Nano-2512","device":"cuda:0"}
```

### 换端口

```bash
# 方式一：运行时改（-e 与 -p 一起改）
docker run -d --name asr --gpus all -e ASR_PORT=8080 -p 8080:8080 \
  -v funasr-cache:/root/.cache/huggingface claude-console-asr

# 方式二：构建时定死默认端口
docker build --build-arg ASR_PORT=8080 -t claude-console-asr ./deploy/funasr
```

## 接口

与现有 `local-agent` 的 `/asr` 形态一致（一次性短音频）：

```
POST /asr
{ "audioBase64": "<base64>", "format": "pcm" }   # web 默认发 16k 单声道 PCM(s16le)
-> { "text": "识别结果" }                          # 失败：{ "error": "...", "message": "..." }
```

`format` 支持 `pcm`（默认）/`wav`/`mp3`/`m4a`/`flac`/`ogg`。

## 可配置环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `ASR_MODEL` | `FunAudioLLM/Fun-ASR-Nano-2512` | 模型 id |
| `ASR_DEVICE` | `cuda:0` | 推理设备 |
| `ASR_LANGUAGE` | `中文` | `中文` / `auto` / `英文` … |
| `ASR_PORT` | `7346` | 监听端口 |
| `ASR_REMOTE_CODE` | 空 | 若仍报 `FunASRNano is not registered`，设为 `/opt/Fun-ASR/model.py` |

## CUDA 版本

`torch>=2.9.0` 用 `--index-url .../cu126`。若你的卡/驱动对应不同 CUDA，
改 Dockerfile 的基础镜像 tag 与 torch index（`cu121`/`cu124`/`cu128`）即可。

## 与 local-agent 对接（待接线，本次未改代码）

计划在 `asr.ts` 增加后端选择：设了 `FUNASR_URL`（如 `http://<gpu-host>:7346`）
就转发到本服务，否则回退腾讯云。详见主 README「语音识别（ASR）」一节。
