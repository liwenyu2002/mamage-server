#!/usr/bin/env python3
"""
Export a MobileCLIP image encoder checkpoint to ONNX.

This script first attempts to load the checkpoint as a TorchScript module
(torch.jit.load). If that succeeds it will export directly to ONNX.

If the checkpoint is a raw state_dict, you must first create a scripted
module (torch.jit.trace/script) using the model class and then run this
script on the scripted file.

Usage examples:
  # If you already have a scripted module (scripted.pt):
  python scripts/export_mobileclip_image_onnx.py --checkpoint scripted.pt --output C:\\models\\mobileclip_s0_image.onnx

  # If you only have a state_dict (mobileclip_s0.pt) you must script it first
  # using your MobileCLIP model class. Example (run in your Python env):
  #   model = YourMobileCLIPImageEncoder(...)  # construct model
  #   model.load_state_dict(torch.load('C:\\models\\mobileclip_s0.pt', map_location='cpu'))
  #   model.eval()
  #   traced = torch.jit.trace(model, torch.randn(1,3,224,224))
  #   traced.save('C:\\models\\mobileclip_s0_scripted.pt')
  # Then run this script against the scripted file.
"""

import argparse
import sys


def main():
    p = argparse.ArgumentParser()
    p.add_argument(
        "--checkpoint",
        required=True,
        help="Path to checkpoint file (prefer a scripted .pt)",
    )
    p.add_argument("--output", required=True, help="Output ONNX file path")
    p.add_argument(
        "--input-size", type=int, default=224, help="Input image size (default 224)"
    )
    p.add_argument("--opset", type=int, default=13, help="ONNX opset version")
    args = p.parse_args()

    try:
        import torch
    except Exception as e:
        print(
            "ERROR: torch is not installed in this Python environment. Install with `pip install torch` (choose correct wheel for your platform)."
        )
        sys.exit(2)

    try:
        print("Attempting to load checkpoint as TorchScript module:", args.checkpoint)
        scripted = None
        try:
            scripted = torch.jit.load(args.checkpoint, map_location="cpu")
        except Exception:
            scripted = None

        if scripted is not None:
            scripted.eval()
            dummy = torch.randn(1, 3, args.input_size, args.input_size)
            print("Exporting scripted module to ONNX ->", args.output)
            torch.onnx.export(
                scripted,
                dummy,
                args.output,
                input_names=["input"],
                output_names=["output"],
                opset_version=args.opset,
                dynamic_axes={"input": {0: "batch"}, "output": {0: "batch"}},
            )
            print("Export complete")
            return

        # If not a scripted module, inform the user how to script it.
        print("\nThe provided checkpoint does not appear to be a TorchScript module.")
        print(
            "If your file is a state_dict (PyTorch checkpoint), you must create a scripted module first."
        )
        print("\nSuggested steps (example):")
        print(
            "  1) In a Python environment that has your MobileCLIP model class available:"
        )
        print("     model = YourMobileCLIPImageEncoder(...)")
        print(
            "     model.load_state_dict(torch.load('C:\\models\\mobileclip_s0.pt', map_location='cpu'))"
        )
        print("     model.eval()")
        print(
            "     traced = torch.jit.trace(model, torch.randn(1,3,{0},{0}))".format(
                args.input_size
            )
        )
        print("     traced.save('C:\\models\\mobileclip_s0_scripted.pt')")
        print("  2) Run this script on the scripted file:")
        print(
            "     python scripts/export_mobileclip_image_onnx.py --checkpoint C:\\models\\mobileclip_s0_scripted.pt --output C:\\models\\mobileclip_s0_image.onnx"
        )
        sys.exit(3)

    except Exception as e:
        print("ERROR during export:", e)
        sys.exit(1)


if __name__ == "__main__":
    main()
