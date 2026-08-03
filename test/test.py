"""
Hot Wheels Real-Time Webcam Detection
Using RF-DETR with threaded inference for smooth display
"""

import threading
import time
import argparse

import cv2
import numpy as np
import torch
import PIL.Image as PILImage


# ─────────────────────────────────────────
# CONFIG — edit these before running
# ─────────────────────────────────────────
CHECKPOINT_PATH = r"C:\Users\apriansyah\projects\capstone\weights\checkpoint_best_total.pth"
CONFIDENCE_THRESHOLD = 0.35
CAMERA_INDEX = 1                      # 1 = USB camera
CLASS_NAMES = ["Cars", "Car"]
# ─────────────────────────────────────────

COLORS = [
    (0, 255, 100),
    (0, 180, 255),
    (255, 80, 80),
    (80, 80, 255),
    (255, 255, 0),
]


def load_model(checkpoint_path: str):
    from rfdetr import RFDETRBase
    print(f"[INFO] Loading RF-DETR from: {checkpoint_path}")
    model = RFDETRBase(
        pretrain_weights=checkpoint_path,
        encoder="dinov2_windowed_base",
        hidden_dim=512,
        patch_size=20,
        dec_layers=5,
        dec_n_points=8,
        num_windows=1,
        positional_encoding_size=35,
        resolution=700,
        num_classes=2,
    )
    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"[INFO] Running on: {device.upper()}")
    print("[INFO] Optimizing for inference...")
    model.optimize_for_inference()
    print("[INFO] Model ready.")
    return model


class InferenceWorker(threading.Thread):
    """Runs model.predict() in background so the display thread never blocks."""

    def __init__(self, model, threshold):
        super().__init__(daemon=True)
        self.model = model
        self.threshold = threshold
        self._lock = threading.Lock()
        self._input_frame = None
        self._detections = None
        self._inference_ms = 0.0
        self._trigger = threading.Event()

    def submit(self, frame):
        with self._lock:
            self._input_frame = frame.copy()
        self._trigger.set()

    def result(self):
        with self._lock:
            return self._detections, self._inference_ms

    def run(self):
        while True:
            self._trigger.wait()
            self._trigger.clear()
            with self._lock:
                frame = self._input_frame.copy() if self._input_frame is not None else None
            if frame is None:
                continue
            t0 = time.perf_counter()
            try:
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                pil_img = PILImage.fromarray(rgb)
                dets = self.model.predict(pil_img, threshold=self.threshold)
            except Exception as exc:
                print(f"[WARN] Inference error: {exc}")
                dets = None
            ms = (time.perf_counter() - t0) * 1000
            with self._lock:
                self._detections = dets
                self._inference_ms = ms


def draw_detections(frame, detections, class_names):
    if detections is None:
        return frame, 0

    if hasattr(detections, "xyxy"):
        boxes     = detections.xyxy
        scores    = getattr(detections, "confidence", [])
        class_ids = getattr(detections, "class_id", [])
    elif isinstance(detections, dict):
        boxes     = detections.get("boxes", [])
        scores    = detections.get("scores", [])
        class_ids = detections.get("labels", [])
    else:
        return frame, 0

    count = 0
    for i, box in enumerate(boxes):
        score  = float(scores[i])  if i < len(scores)    else 0.0
        cls_id = int(class_ids[i]) if i < len(class_ids) else 0

        x1, y1, x2, y2 = map(int, box[:4])
        color    = COLORS[cls_id % len(COLORS)]
        cls_name = class_names[cls_id] if cls_id < len(class_names) else f"cls{cls_id}"

        cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)

        label = f"{cls_name} {score:.2f}"
        (lw, lh), bl = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.6, 2)
        cv2.rectangle(frame, (x1, y1 - lh - bl - 6), (x1 + lw + 4, y1), color, -1)
        cv2.putText(frame, label, (x1 + 2, y1 - bl - 2),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 0), 2)
        count += 1

    return frame, count


def draw_hud(frame, fps, count, inference_ms):
    overlay = frame.copy()
    cv2.rectangle(overlay, (0, 0), (frame.shape[1], 44), (20, 20, 20), -1)
    cv2.addWeighted(overlay, 0.6, frame, 0.4, 0, frame)
    text = (f"FPS: {fps:.1f}  |  Detected: {count}  |  "
            f"Inference: {inference_ms:.0f}ms  |  [Q] Quit  [S] Screenshot")
    cv2.putText(frame, text, (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (200, 255, 200), 1)
    return frame


def open_camera(camera_index):
    for backend in (cv2.CAP_DSHOW, cv2.CAP_MSMF, cv2.CAP_ANY):
        cap = cv2.VideoCapture(camera_index, backend)
        if cap.isOpened():
            time.sleep(0.5)
            for _ in range(5):
                ret, frame = cap.read()
                if ret and frame is not None:
                    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
                    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
                    return cap
        cap.release()
    raise RuntimeError(
        f"Cannot open camera {camera_index}. "
        "Close any app using the camera and try again."
    )


def run_webcam(model, camera_index, threshold):
    cap = open_camera(camera_index)
    print("\n[INFO] Webcam opened. Show a Hot Wheels car to the camera.")
    print("[INFO] Press Q to quit | S to save screenshot\n")

    worker = InferenceWorker(model, threshold)
    worker.start()

    fps_counter  = 0
    fps          = 0.0
    fps_timer    = time.time()
    screenshot_n = 0
    frame_n      = 0
    INFER_EVERY  = 3   # run inference every N captured frames to reduce lag

    while True:
        ret, frame = cap.read()
        if not ret:
            print("[ERROR] Failed to read frame.")
            break

        frame_n += 1
        if frame_n % INFER_EVERY == 0:
            worker.submit(frame)

        detections, inference_ms = worker.result()
        frame, count = draw_detections(frame, detections, CLASS_NAMES)

        fps_counter += 1
        elapsed = time.time() - fps_timer
        if elapsed >= 1.0:
            fps = fps_counter / elapsed
            fps_counter = 0
            fps_timer = time.time()

        frame = draw_hud(frame, fps, count, inference_ms)
        cv2.imshow("Hot Wheels Detection", frame)

        key = cv2.waitKey(1) & 0xFF
        if key == ord("q"):
            print("[INFO] Quit.")
            break
        elif key == ord("s"):
            name = f"screenshot_{screenshot_n:03d}.jpg"
            cv2.imwrite(name, frame)
            screenshot_n += 1
            print(f"[INFO] Saved: {name}")

    cap.release()
    cv2.destroyAllWindows()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", default=CHECKPOINT_PATH)
    parser.add_argument("--threshold",  default=CONFIDENCE_THRESHOLD, type=float)
    parser.add_argument("--camera",     default=CAMERA_INDEX, type=int)
    args = parser.parse_args()

    model = load_model(args.checkpoint)
    run_webcam(model, args.camera, args.threshold)
