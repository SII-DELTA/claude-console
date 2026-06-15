# Fun-ASR-Nano-2512 自建 ASR 服务（GPU 版），替代腾讯云「一句话识别」。
#
# 前置：Linux + NVIDIA 驱动 + nvidia-container-toolkit（docker 才能 --gpus）。
# 构建：docker build -t claude-console-asr ./deploy/funasr
# 运行：docker run -d --name asr --gpus all -p 7346:7346 \
#          -v funasr-cache:/root/.cache/huggingface claude-console-asr
#   首次启动会从 HuggingFace 下载模型权重到挂载卷（持久化，重启不再下）。
#
# CUDA 基础镜像：torch 2.9 的 cu126 wheel 自带 CUDA/cuDNN 运行库，
# 这里用 cuda runtime 镜像保证驱动接口齐全。若你的卡/驱动对应不同 CUDA，
# 改下面的基础镜像 tag 与 torch --index-url（cu121/cu124/cu128）即可。
FROM nvidia/cuda:12.6.2-cudnn-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/root/.cache/huggingface \
    PIP_NO_CACHE_DIR=1

# 系统依赖：python、git（clone Fun-ASR）、ffmpeg（mp3/m4a 解码）、
# libsndfile（soundfile）、build 工具（pyopenjtalk-plus 等原生 wheel）。
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3.10 python3-pip python3.10-dev git ffmpeg libsndfile1 \
      build-essential cmake \
 && ln -sf /usr/bin/python3.10 /usr/bin/python \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt

# Fun-ASR-Nano 必须用官方专用仓库（注册 FunASRNano 模型类 + 提供 remote_code/model.py）；
# 直接 `pip install funasr` 会报 "FunASRNano is not registered"（见 README）。
RUN git clone --depth 1 https://github.com/FunAudioLLM/Fun-ASR.git

WORKDIR /opt/Fun-ASR

# 先按 CUDA 12.6 装 torch/torchaudio，再装模型自带 requirements（含 funasr/transformers 等），
# 最后装 HTTP 服务依赖。
RUN pip install --upgrade pip \
 && pip install "torch>=2.9.0" "torchaudio>=2.9.0" --index-url https://download.pytorch.org/whl/cu126 \
 && pip install -r requirements.txt \
 && pip install fastapi "uvicorn[standard]"

COPY server.py /opt/Fun-ASR/server.py

# 端口可配置：构建时 `--build-arg ASR_PORT=8080`，或运行时 `-e ASR_PORT=8080`
# （运行时记得让 -p 与之匹配）。server.py 读取 ASR_PORT 监听。
ARG ASR_PORT=7346
ENV ASR_MODEL=FunAudioLLM/Fun-ASR-Nano-2512 \
    ASR_DEVICE=cuda:0 \
    ASR_LANGUAGE=中文 \
    ASR_PORT=${ASR_PORT}
EXPOSE ${ASR_PORT}

CMD ["python", "server.py"]
