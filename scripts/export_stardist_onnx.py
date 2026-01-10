#!/usr/bin/env python3
"""
Export a pretrained StarDist2D model to ONNX for browser inference (onnxruntime-web).

This script downloads the StarDist pretrained model (2D_versatile_he) and converts it to ONNX
with a fixed input size (default 256x256 RGB) for fast viewport inference.

Output:
  viewer/models/stardist_2D_versatile_he_256.onnx

Usage (from repo root):
  python scripts/export_stardist_onnx.py

Notes:
  - Requires a Python env with: stardist, tensorflow, tf2onnx, onnx
  - Conversion produces an NHWC model: input [1,H,W,3]
"""

from __future__ import annotations

import os
import sys


def main() -> int:
    try:
        import tensorflow as tf
        import tf2onnx
        from stardist.models import StarDist2D
    except Exception as e:
        print("Missing deps. Create a venv and install:\n"
              "  pip install stardist tensorflow tf2onnx onnx\n\n"
              f"Import error: {e}")
        return 2

    input_size = int(os.environ.get("STARDIST_INPUT", "256"))
    model_name = os.environ.get("STARDIST_PRETRAINED", "2D_versatile_he")

    print(f"[export] loading pretrained StarDist model: {model_name}")
    sd = StarDist2D.from_pretrained(model_name)

    # Underlying Keras model
    keras_model = sd.keras_model
    keras_model.trainable = False

    # Fixed-shape input signature for stable ONNX export
    # StarDist2D models typically expect float32 in [0..1]
    spec = (tf.TensorSpec((1, input_size, input_size, 3), tf.float32, name="input"),)

    out_dir = os.path.join("viewer", "models")
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, f"stardist_{model_name}_{input_size}.onnx")

    print(f"[export] converting to ONNX -> {out_path}")
    model_proto, _ = tf2onnx.convert.from_keras(
        keras_model,
        input_signature=spec,
        opset=13,
        output_path=out_path,
    )
    # output_path already written; keep model_proto to avoid unused var warnings
    _ = model_proto

    size_mb = os.path.getsize(out_path) / (1024 * 1024)
    print(f"[export] done. size={size_mb:.1f}MB")
    print("[export] in the viewer console, set:\n"
          f"  window.StarDistSegmentation.setModelUrl('/models/{os.path.basename(out_path)}')")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

