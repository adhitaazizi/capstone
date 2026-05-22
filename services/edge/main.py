"""Main orchestrator for the simulated edge-compute pipeline."""

from __future__ import annotations

import logging
import signal
import threading
from importlib import import_module
from typing import Any, Dict, List, Optional, Protocol

EdgeConfigLoader = import_module("config")
CrossCameraDeduplicator = import_module("deduplication").CrossCameraDeduplicator
_frame_capture_mod = import_module("frame_capture")
FrameCapture = _frame_capture_mod.FrameCapture
RoboflowInference = import_module("inference").RoboflowInference
MJPEGServer = import_module("mjpeg_server").MJPEGServer
EdgePublisher = import_module("publisher").EdgePublisher
FIFOReconciler = import_module("reconciler").FIFOReconciler
load_config = EdgeConfigLoader.load_config


class EdgeConfig(Protocol):
    confidence_threshold: float
    roboflow_api_url: str
    roboflow_api_key: str
    roboflow_workspace: str
    roboflow_workflow: str
    roboflow_image_input: str
    roboflow_stream_outputs: list[str]
    roboflow_data_outputs: list[str]
    roboflow_processing_timeout: int
    roboflow_requested_plan: str | None
    roboflow_requested_region: str | None
    camera_sources: dict[str, str]
    rabbitmq_url: str
    mjpeg_port: int
    active_session_id: str
    spindle_gap_seconds: float
    entry_cameras: list[str]
    conveyor_travel_seconds: float
    exit_cameras: list[str]
    health_interval_seconds: int
    target_fps: int

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
logger = logging.getLogger("edge-main")


class EdgeOrchestrator:
    """Capture, infer, deduplicate, reconcile, publish, repeat."""

    def __init__(self, config: EdgeConfig) -> None:
        self.config = config
        self.stop_event = threading.Event()
        self.captures = {
            camera_id: FrameCapture(camera_id, source, target_fps=config.target_fps)
            for camera_id, source in config.camera_sources.items()
        }
        self.inference = RoboflowInference(
            api_key=config.roboflow_api_key,
            api_url=config.roboflow_api_url,
            workspace=config.roboflow_workspace,
            workflow=config.roboflow_workflow,
            image_input=config.roboflow_image_input,
            camera_sources=config.camera_sources,
            confidence_threshold=config.confidence_threshold,
            stream_output=config.roboflow_stream_outputs,
            data_output=config.roboflow_data_outputs,
            processing_timeout=config.roboflow_processing_timeout,
            requested_plan=config.roboflow_requested_plan,
            requested_region=config.roboflow_requested_region,
        )
        self.deduplicator = CrossCameraDeduplicator.identity_for(self.captures.keys())
        self.reconciler = FIFOReconciler()
        self.publisher = EdgePublisher(config.rabbitmq_url)
        self.mjpeg_server = MJPEGServer(port=config.mjpeg_port)
        self.health_thread: Optional[threading.Thread] = None
        self._missing_checkpoint_cameras: set[tuple[str, str]] = set()

    def start(self) -> None:
        for capture in self.captures.values():
            capture.open()
        self.inference.start()
        self.publisher.connect()
        self.mjpeg_server.start(self.captures)
        self.health_thread = threading.Thread(target=self._health_loop, daemon=True)
        self.health_thread.start()
        logger.info(
            "Edge orchestrator started for session %s (backend=roboflow)",
            self.config.active_session_id,
        )

    def run_forever(self) -> None:
        self.start()
        try:
            while not self.stop_event.is_set():
                self.run_once()
                self._sleep(self.config.spindle_gap_seconds)
        finally:
            self.stop()

    def run_once(self) -> None:
        entry = self._process_checkpoint("entry", self.config.entry_cameras)
        spindle_pass_id = self.reconciler.push_entry(
            self.config.active_session_id, entry["deduplicated_count"]
        )
        self.publisher.publish_entry(
            {
                **entry,
                "spindle_pass_id": spindle_pass_id,
                "session_id": self.config.active_session_id,
            }
        )

        self._sleep(self.config.conveyor_travel_seconds)
        exit_result = self._process_checkpoint("exit", self.config.exit_cameras)
        reconciliation = self.reconciler.pop_exit(exit_result["deduplicated_count"])
        if reconciliation is None:
            logger.warning("Skipping exit publish because no FIFO entry was available")
            return

        self.publisher.publish_exit(
            {
                **exit_result,
                "spindle_pass_id": reconciliation["spindle_pass_id"],
                "session_id": reconciliation["session_id"],
                "entry_count": reconciliation["entry_count"],
                "exit_count": reconciliation["exit_count"],
                "reconciliation_status": reconciliation["status"],
                "mismatch_delta": reconciliation["mismatch_delta"],
            }
        )

    def stop(self) -> None:
        self.stop_event.set()
        self.mjpeg_server.stop()
        self.inference.stop()
        for capture in self.captures.values():
            capture.release()
        self.publisher.close()
        logger.info("Edge orchestrator stopped")

    def _process_checkpoint(self, checkpoint: str, camera_ids: List[str]) -> Dict[str, Any]:
        detections_by_camera: Dict[str, List[Dict[str, Any]]] = {}
        raw_counts: Dict[str, int] = {}
        confidence_values: List[float] = []
        latencies: List[int] = []

        configured_camera_ids: List[str] = []

        for camera_id in camera_ids:
            capture = self.captures.get(camera_id)
            if capture is None:
                warning_key = (checkpoint, camera_id)
                if warning_key not in self._missing_checkpoint_cameras:
                    logger.warning(
                        "Skipping %s checkpoint camera %s because it has no configured source",
                        checkpoint,
                        camera_id,
                    )
                    self._missing_checkpoint_cameras.add(warning_key)
                continue

            configured_camera_ids.append(camera_id)
            _ = capture.capture_frame()

            result = self.inference.detect(camera_id, capture.last_model_frame)
            detections_by_camera[camera_id] = result["detections"]
            raw_counts[camera_id] = result["raw_count"]
            if result["filtered_count"]:
                confidence_values.append(result["confidence_avg"])
            latencies.append(result["latency_ms"])

        deduplicated_count = self.deduplicator.deduplicate_many(detections_by_camera)
        confidence_avg = (
            sum(confidence_values) / len(confidence_values) if confidence_values else 0.0
        )
        latency_ms = int(sum(latencies) / len(latencies)) if latencies else 0
        logger.info(
            "%s checkpoint cameras=%s deduplicated_count=%s raw_counts=%s",
            checkpoint.upper(),
            configured_camera_ids,
            deduplicated_count,
            raw_counts,
        )
        return {
            "camera_ids": configured_camera_ids,
            "deduplicated_count": deduplicated_count,
            "raw_counts": raw_counts,
            "confidence_avg": round(confidence_avg, 4),
            "inference_latency_ms": latency_ms,
        }

    def _health_loop(self) -> None:
        while not self.stop_event.is_set():
            try:
                for camera_id, capture in self.captures.items():
                    status = "online" if capture.last_frame is not None else "offline"
                    self.publisher.publish_camera_health(camera_id, status, capture.actual_fps)
                self.publisher.publish_heartbeat(
                    self.config.active_session_id, self.reconciler.depth
                )
            except Exception as exc:  # Keep health telemetry from killing the pipeline.
                logger.warning("Health publish failed: %s", exc)
            self._sleep(self.config.health_interval_seconds)

    def _sleep(self, seconds: float) -> None:
        self.stop_event.wait(seconds)


def main() -> None:
    config = load_config()
    orchestrator = EdgeOrchestrator(config)

    def handle_signal(signum: int, _frame: Any) -> None:
        logger.info("Received signal %s", signum)
        orchestrator.stop_event.set()

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)
    orchestrator.run_forever()


if __name__ == "__main__":
    main()
