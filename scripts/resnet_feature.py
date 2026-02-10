import torch
import torchvision.models as models
import torchvision.transforms as transforms
import io
import contextlib
from PIL import Image
import numpy as np
import sys
import os
import json

print("正在加载 ResNet-50 模型...", file=sys.stderr)

# Some torchvision/torch hub operations print download progress to stdout/stderr
# which would pollute our JSON output. Redirect stdout/stderr during model load.
try:
    buf_out = io.StringIO()
    buf_err = io.StringIO()
    with contextlib.redirect_stdout(buf_out), contextlib.redirect_stderr(buf_err):
        weights = models.ResNet50_Weights.DEFAULT
        model = models.resnet50(weights=weights)
        modules = list(model.children())[:-1]
        model = torch.nn.Sequential(*modules)
        model.eval()
        preprocess = weights.transforms()
except Exception as e:
    print("Failed loading ResNet model: " + str(e), file=sys.stderr)
    # re-raise so caller can see the error
    raise


def get_embedding(image_path):
    if not os.path.exists(image_path):
        return None
    try:
        img = Image.open(image_path).convert("RGB")
        batch_t = preprocess(img).unsqueeze(0)
        with torch.no_grad():
            output = model(batch_t)
        embedding = torch.flatten(output).numpy()
        norm = np.linalg.norm(embedding)
        if norm > 0:
            embedding = embedding / norm
        return [round(float(x), 6) for x in embedding]
    except Exception as e:
        print(f"Error processing {image_path}: {e}", file=sys.stderr)
        return None


if __name__ == "__main__":
    if len(sys.argv) > 1:
        img_path = sys.argv[1]
        vec = get_embedding(img_path)
        if vec:
            print(json.dumps(vec))
            sys.exit(0)
        else:
            sys.exit(2)
    else:
        print("请提供图片路径参数", file=sys.stderr)
        sys.exit(2)
