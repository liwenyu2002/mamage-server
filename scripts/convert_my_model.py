import torch
import mobileclip
import os

# === 配置路径 (根据你的实际路径设置) ===
CHECKPOINT_PATH = r"C:\models\mobileclip_s0.pt"
OUTPUT_ONNX_PATH = r"C:\models\mobileclip_s0_image.onnx"
MODEL_NAME = "mobileclip_s0"


def export_onnx():
    print(f"正在准备转换...")
    print(f"1. 模型架构: {MODEL_NAME}")
    print(f"2. 权重文件: {CHECKPOINT_PATH}")

    if not os.path.exists(CHECKPOINT_PATH):
        print(f"❌ 错误: 找不到文件 {CHECKPOINT_PATH}")
        return

    # 1. 创建模型骨架 (不加载默认权重，因为我们要加载本地的)
    try:
        model, _, _ = mobileclip.create_model_and_transforms(
            MODEL_NAME, pretrained=None
        )
        print("✅ 模型骨架创建成功")
    except Exception as e:
        print(f"❌ 创建模型失败，请检查是否安装了 mobileclip 库: {e}")
        return

    # 2. 加载你下载的 .pt 权重
    try:
        checkpoint = torch.load(CHECKPOINT_PATH, map_location="cpu")
        # 处理可能存在的键名差异 (有些 checkpoint 会包裹在 'model' 或 'state_dict' 键下)
        if "model" in checkpoint:
            state_dict = checkpoint["model"]
        elif "state_dict" in checkpoint:
            state_dict = checkpoint["state_dict"]
        else:
            state_dict = checkpoint

        # 加载权重
        msg = model.load_state_dict(state_dict, strict=False)
        print(f"✅ 权重加载成功 (未匹配键: {len(msg.missing_keys)})")
    except Exception as e:
        print(f"❌ 加载权重失败: {e}")
        return

    # 3. 提取图像编码器 (我们只需要这一部分做以图搜图)
    model.eval()
    image_encoder = model.image_encoder

    # 4. 准备假数据 (Dummy Input) 用于测试跑通模型
    # MobileCLIP-S0 的标准输入是 1张图片, 3通道, 224x224
    dummy_input = torch.randn(1, 3, 224, 224)

    # 5. 导出为 ONNX
    print(f"🚀 开始导出到 {OUTPUT_ONNX_PATH} ...")
    try:
        torch.onnx.export(
            image_encoder,  # 只导出图像部分
            dummy_input,  # 假输入
            OUTPUT_ONNX_PATH,  # 输出路径
            input_names=["image"],  # 输入变量名 (代码里调用的名字)
            output_names=["features"],  # 输出变量名
            dynamic_axes={  # 允许批量处理 (一次传多张图)
                "image": {0: "batch_size"},
                "features": {0: "batch_size"},
            },
            opset_version=14,  # 兼容性较好的版本
        )
        print(f"🎉 成功! ONNX 文件已生成: {OUTPUT_ONNX_PATH}")
    except Exception as e:
        print(f"❌ 导出失败: {e}")


if __name__ == "__main__":
    export_onnx()
