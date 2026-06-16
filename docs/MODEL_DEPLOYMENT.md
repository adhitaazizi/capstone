# Model deployment

## What must be transferred

`checkpoint_best_total.pth` is not sufficient by itself unless it is a fully
serialized model. Ask the training owner for:

1. The checkpoint file.
2. The exact model architecture and library versions.
3. Class names and class-to-index mapping.
4. Input resolution and preprocessing/normalization settings.
5. The inference or export script used to load the checkpoint.
6. Validation metrics and the dataset/model version.
7. A SHA-256 checksum.

The preferred handoff is an ONNX export plus metadata because ONNX is less tied
to the original Python training code than a raw PyTorch checkpoint.

## Development handoff

The training owner uploads a versioned archive to a private artifact location,
for example a private GitHub Release, S3-compatible object storage, or Supabase
Storage. Do not commit the model to the normal Git repository.

Download the artifact into:

```text
C:\kuliah\capstone\weights\checkpoint_best_total.pth
```

Set the edge environment variable to the container path, not a developer's
Windows profile path:

```dotenv
INFERENCE_BACKEND=local
LOCAL_MODEL_PATH=/models/checkpoint_best_total.pth
```

## Production options

### Recommended: versioned artifact download

Store model versions in private object storage:

```text
spraycount-models/rtdetr/v1/model.onnx
spraycount-models/rtdetr/v1/metadata.json
spraycount-models/rtdetr/v1/model.sha256
```

At deployment, download the selected version, verify its checksum, and mount it
read-only into the inference container. This allows model upgrades without
rebuilding the application image.

### Alternative: private inference image

Build a dedicated inference image containing the runtime and a pinned model
version, then publish it to a private container registry. This is reproducible
but creates a large image for every model update.

## Required metadata

Each deployed model version should include a `metadata.json` file containing:

```json
{
  "model_name": "spraycount-rtdetr",
  "version": "1",
  "format": "onnx",
  "classes": ["car-body"],
  "input_width": 640,
  "input_height": 640,
  "confidence_threshold": 0.5,
  "sha256": "replace-with-real-checksum"
}
```

## Important limitation in the current repository

The current edge service implements Roboflow WebRTC inference only. It does not
yet contain a PyTorch or ONNX local inference implementation. The local backend
cannot be completed reliably until the checkpoint format, architecture code,
class mapping, and preprocessing information are available.
