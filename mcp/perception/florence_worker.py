#!/usr/bin/env python3
"""Offline JSONL worker for the optional Florence-2 perception fallback."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from PIL import Image
import torch
from transformers import AutoProcessor, Florence2ForConditionalGeneration


def load_runtime(model_path: str) -> tuple[Any, Any, str, torch.dtype]:
    """Load the pinned local model without executing remote repository code."""
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    dtype = torch.float16 if device == "mps" else torch.float32
    processor = AutoProcessor.from_pretrained(model_path, local_files_only=True, trust_remote_code=False)
    model = Florence2ForConditionalGeneration.from_pretrained(
        model_path,
        local_files_only=True,
        dtype=dtype,
        use_safetensors=True,
    ).to(device)
    model.eval()
    return processor, model, device, dtype


def checkerboard_rgb(path: str, maximum: int = 1024) -> tuple[Image.Image, tuple[int, int]]:
    """Flatten alpha on a neutral checkerboard and bound the inference size."""
    source = Image.open(path).convert("RGBA")
    source_size = source.size
    checker = Image.new("RGBA", source.size, (136, 136, 136, 255))
    pixels = checker.load()
    for y in range(0, source.height, 16):
        for x in range(0, source.width, 16):
            shade = 120 if (x // 16 + y // 16) % 2 else 152
            for yy in range(y, min(y + 16, source.height)):
                for xx in range(x, min(x + 16, source.width)):
                    pixels[xx, yy] = (shade, shade, shade, 255)
    flattened = Image.alpha_composite(checker, source).convert("RGB")
    if max(flattened.size) > maximum:
        ratio = maximum / max(flattened.size)
        flattened = flattened.resize(
            (max(1, round(flattened.width * ratio)), max(1, round(flattened.height * ratio))),
            Image.Resampling.NEAREST,
        )
    return flattened, source_size


def restore_box(box: list[float], inference_size: tuple[int, int], source_size: tuple[int, int]) -> list[float]:
    """Map an inference-image box back into original source pixels."""
    scale_x = source_size[0] / max(1, inference_size[0])
    scale_y = source_size[1] / max(1, inference_size[1])
    return [box[0] * scale_x, box[1] * scale_y, box[2] * scale_x, box[3] * scale_y]


def run_task(
    processor: Any,
    model: Any,
    device: str,
    dtype: torch.dtype,
    image: Image.Image,
    task: str,
) -> dict[str, Any]:
    """Run one supported Florence task and return its parsed structured output."""
    inputs = processor(text=task, images=image, return_tensors="pt")
    moved = {}
    for key, value in inputs.items():
        if not hasattr(value, "to"):
            moved[key] = value
        elif key == "pixel_values":
            moved[key] = value.to(device=device, dtype=dtype)
        else:
            moved[key] = value.to(device)
    with torch.inference_mode():
        generated = model.generate(**moved, max_new_tokens=1024, num_beams=3, do_sample=False)
    text = processor.batch_decode(generated, skip_special_tokens=False)[0]
    return processor.post_process_generation(text, task=task, image_size=image.size)[task]


def detect(
    processor: Any,
    model: Any,
    device: str,
    dtype: torch.dtype,
    frames: list[dict[str, Any]],
    targets: list[str],
) -> dict[str, Any]:
    """Run dense region captioning and optional OCR on a bounded file list."""
    detections: list[dict[str, Any]] = []
    for position, frame_input in enumerate(frames[:8]):
        file_path = str(frame_input.get("file", ""))
        frame = int(frame_input.get("frame", position))
        if not Path(file_path).is_file():
            continue
        image, source_size = checkerboard_rgb(file_path)
        dense = run_task(processor, model, device, dtype, image, "<DENSE_REGION_CAPTION>")
        for bbox, label in zip(dense.get("bboxes", []), dense.get("labels", [])):
            detections.append(
                {"frame": frame, "bbox": restore_box(bbox, image.size, source_size), "label": label}
            )
        if "text" in targets:
            ocr = run_task(processor, model, device, dtype, image, "<OCR_WITH_REGION>")
            for bbox, label in zip(ocr.get("quad_boxes", []), ocr.get("labels", [])):
                if len(bbox) == 8:
                    xs = bbox[0::2]
                    ys = bbox[1::2]
                    detections.append({
                        "frame": frame,
                        "bbox": restore_box([min(xs), min(ys), max(xs), max(ys)], image.size, source_size),
                        "label": label,
                    })
    return {"detections": detections}


def main() -> int:
    """Serve newline-delimited inference requests until stdin closes."""
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    args = parser.parse_args()
    processor, model, device, dtype = load_runtime(args.model)
    for line in sys.stdin:
        request: dict[str, Any] = {}
        try:
            request = json.loads(line)
            result = detect(
                processor,
                model,
                device,
                dtype,
                [item for item in request.get("frames", []) if isinstance(item, dict)],
                [str(item) for item in request.get("targets", [])],
            )
            response = {"id": request.get("id"), "result": result}
        except Exception as error:  # Worker boundary must report structured failures.
            response = {
                "id": request.get("id"),
                "error": {"code": "MODEL_ERROR", "message": str(error)},
            }
        print(json.dumps(response, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
