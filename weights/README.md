# Model artifacts

Place local model artifacts in this directory. Model files are intentionally
excluded from Git because they are large binary deployment artifacts.

Expected development path:

```text
weights/checkpoint_best_total.pth
```

Preferred production artifact:

```text
weights/spraycount-rtdetr-v1.onnx
```

Record the SHA-256 checksum whenever a model is distributed:

```powershell
Get-FileHash .\weights\checkpoint_best_total.pth -Algorithm SHA256
```

Only load PyTorch checkpoints received from a trusted project member. A `.pth`
file can contain Python pickle data and must not be treated as an inert file.
