# GPU inference worker. Needs an NVIDIA GPU + the NVIDIA Container Toolkit on
# the host: `docker run --gpus all ...` or, via this project's docker-compose,
# `docker compose --profile inference up -d inference`.
#
# The base image ships a CUDA-matched torch/torchvision build already, so
# requirements.txt deliberately does not list them — letting pip reinstall
# torch here would risk silently swapping in a CPU-only wheel from PyPI.
# After changing the base image tag or requirements.txt, confirm CUDA is
# still visible:
#   docker run --rm --gpus all <image> python -c "import torch; print(torch.cuda.is_available())"
FROM pytorch/pytorch:2.4.1-cuda12.1-cudnn9-runtime

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    libglib2.0-0 \
    libgl1 \
    libsrtp2-1 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

CMD ["python", "main.py"]
