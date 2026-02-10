#!/usr/bin/env python3
"""
Script a MobileCLIP model from a PyTorch checkpoint (state_dict) into a TorchScript file.

This script attempts to import a model class from a module you specify and
instantiate it (with optional JSON kwargs). If your model constructor requires
complex args, edit this file to construct the model directly.

Usage examples:
  # simple: provide module and class names, constructor takes no args
  python scripts/script_mobileclip_from_checkpoint.py --checkpoint C:\\models\\mobileclip_s0.pt --output C:\\models\\mobileclip_s0_scripted.pt --model-module mymodels.mobileclip --model-class MobileCLIPImageEncoder

  # with constructor kwargs (JSON string):
  python scripts/script_mobileclip_from_checkpoint.py --checkpoint C:\\models\\mobileclip_s0.pt --output C:\\models\\mobileclip_s0_scripted.pt --model-module mymodels.mobileclip --model-class MobileCLIPImageEncoder --constructor-kwargs '{"embed_dim":512}'

If you cannot import the model by module/class name, edit this file and create the
model instance manually in the function `build_model_from_checkpoint()`.
"""

import argparse
import json
import sys
import importlib


def build_model_from_checkpoint(
    checkpoint_path, module_name=None, class_name=None, constructor_kwargs=None
):
    import torch

    # If user supplied module and class, try to import and construct
    if module_name and class_name:
        try:
            mod = importlib.import_module(module_name)
            ModelClass = getattr(mod, class_name)
            if constructor_kwargs:
                model = ModelClass(**constructor_kwargs)
            else:
                model = ModelClass()
            print("Instantiated model from", module_name, class_name)
        except Exception as e:
            print("Failed to import/instantiate model:", e)
            raise
    else:
        raise RuntimeError(
            "No model_module/model_class provided. Edit this script to construct the model manually."
        )

    # Load checkpoint
    sd = torch.load(checkpoint_path, map_location="cpu")
    # common wrappers
    if isinstance(sd, dict) and "state_dict" in sd:
        sd = sd["state_dict"]

    # Try to adapt keys if they were saved with module prefix (common in DataParallel)
    try:
        model.load_state_dict(sd)
    except Exception as e:
        print("Direct load_state_dict failed, trying to strip prefix from keys:", e)
        new_sd = {}
        for k, v in sd.items():
            nk = k
            if k.startswith("module."):
                nk = k[len("module.") :]
            new_sd[nk] = v
        model.load_state_dict(new_sd)

    model.eval()
    return model


def main():
    p = argparse.ArgumentParser()
    p.add_argument(
        "--checkpoint", required=True, help="Path to checkpoint (state_dict)"
    )
    p.add_argument("--output", required=True, help="Output TorchScript file path")
    p.add_argument(
        "--model-module",
        help="Python module path containing model class (e.g. mypkg.models.mobileclip)",
    )
    p.add_argument(
        "--model-class",
        help="Model class name inside module (e.g. MobileCLIPImageEncoder)",
    )
    p.add_argument(
        "--constructor-kwargs", help="JSON string of kwargs for model constructor"
    )
    p.add_argument(
        "--input-size", type=int, default=224, help="Input image size for tracing"
    )
    args = p.parse_args()

    try:
        import torch
    except Exception:
        print("ERROR: torch not installed. Install torch in this environment first.")
        sys.exit(2)

    kwargs = None
    if args.constructor_kwargs:
        try:
            kwargs = json.loads(args.constructor_kwargs)
        except Exception as e:
            print("Failed to parse constructor kwargs JSON:", e)
            sys.exit(3)

    try:
        model = build_model_from_checkpoint(
            args.checkpoint, args.model_module, args.model_class, kwargs
        )
    except Exception as e:
        print("Failed to build model:", e)
        print(
            "\nIf your model class is not importable, open this file and modify `build_model_from_checkpoint` to construct the model instance manually."
        )
        sys.exit(4)

    # Trace and save
    dummy = torch.randn(1, 3, args.input_size, args.input_size)
    try:
        traced = torch.jit.trace(model, dummy)
        traced.save(args.output)
        print("Saved scripted module to", args.output)
    except Exception as e:
        print("TorchScript trace/save failed:", e)
        sys.exit(5)


if __name__ == "__main__":
    main()
