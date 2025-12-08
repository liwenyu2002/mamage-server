// ai_for_tags.js
// 使用阿里云百炼 DashScope 的多模态模型（带视觉能力）给图片打标签

const { OpenAI } = require("openai");
const http = require("http");
const https = require("https");
const fs = require("fs");

// ⚠️ 强烈建议用环境变量：setx DASHSCOPE_API_KEY "你的Key"
// 模块不会在加载时要求 API Key；在实际调用分析时会按需读取环境变量。

// 视觉模型（根据你账号实际支持情况修改）
const VISION_MODEL = "qwen2-vl-72b-instruct";

// 清理可能干扰的环境变量
try {
  delete process.env.OPENAI_API_KEY;
} catch (e) {
  // ignore
}

// 按需创建 OpenAI 客户端，避免模块加载阶段依赖环境变量或抛出错误
function getOpenAIClient() {
  const key = process.env.DASHSCOPE_API_KEY || "sk-11fe87f4c96a4c7b920532724d77eef6";
  if (!key) {
    throw new Error('Missing DASHSCOPE_API_KEY or OPENAI_API_KEY in environment');
  }
  return new OpenAI({ apiKey: key, baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1' });
}

/**
 * 简单 HEAD 请求，调试用：看 URL 能不能访问 / content-type 是否是图片
 */
async function headRequest(url) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(url);
      const lib = u.protocol === "https:" ? https : http;
      const opts = { method: "HEAD" };
      const req = lib.request(u, opts, (res) => {
        const headers = res.headers || {};
        resolve({ statusCode: res.statusCode, headers });
      });
      req.on("error", (err) => reject(err));
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

/**
 * 辅助：拉取二进制数据（验证 URL 真的是图片；也用于转 base64）
 */
async function fetchBinary(url, opts = {}) {
  const maxRedirects = opts.maxRedirects || 5;
  const timeoutMs = opts.timeoutMs || 15000;

  return new Promise((resolve, reject) => {
    let redirects = 0;

    function _get(u) {
      try {
        const lib = u.protocol === "https:" ? https : http;
        const req = lib.get(u, { timeout: timeoutMs }, (res) => {
          // 处理重定向
          if (
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location
          ) {
            if (redirects >= maxRedirects) {
              return reject(new Error("Too many redirects"));
            }
            redirects++;
            const next = new URL(res.headers.location, u);
            res.resume();
            return _get(next);
          }

          if (res.statusCode !== 200) {
            const err = new Error("HTTP status " + res.statusCode);
            err.statusCode = res.statusCode;
            res.resume();
            return reject(err);
          }

          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve(Buffer.concat(chunks)));
          res.on("error", (err) => reject(err));
        });

        req.on("error", (err) => reject(err));
        req.on("timeout", () => {
          req.destroy(new Error("Request timeout"));
        });
      } catch (e) {
        reject(e);
      }
    }

    try {
      _get(new URL(url));
    } catch (e) {
      reject(e);
    }
  });
}

/**
 * 真正发图给模型分析（多模态）
 * 关键点：
 *  1. 先本地拉图并转成 data URL，避免 DashScope 自己访问 ngrok 出问题；
 *  2. messages[1].content 是数组，包含 image_url 和 text 两块；
 *  3. 模型会真的“看图”，而不是只看 URL 文本。
 */
async function analyze(imageUrl) {
  // 先准备一个要真正发给模型用的 URL
  let imageUrlForModel = imageUrl;

  // 如果是 http/https 的网络地址，就先在本地拉下来转 base64
  if (/^https?:\/\//i.test(imageUrl)) {
    try {
      const buf = await fetchBinary(imageUrl);
      // 简单假定为 JPEG；如果以后有 PNG，可以用 HEAD 的 content-type 判断
      const mime = "image/jpeg";
      const base64 = buf.toString("base64");
      imageUrlForModel = `data:${mime};base64,${base64}`;
      // 如需调试可打开：
      // console.log("[ai_for_tags] use data url, size=", base64.length);
    } catch (e) {
      console.error(
        "[ai_for_tags] failed to fetch & encode image, fallback to raw url:",
        e && e.message ? e.message : e
      );
      imageUrlForModel = imageUrl;
    }
  }

  const openai = getOpenAIClient();

  const resp = await openai.chat.completions.create({
    model: VISION_MODEL,
    messages: [
      {
        role: "system",
        content:
          "你是高校新闻中心的图片审核与打标助手。【首要任务：先判断 AI 选片标签】只要出现下面任一情况，都必须判定为 AI rejected（优先级最高）：1. 前景有大面积无关人物或物体遮挡主要活动内容，例如：画面边缘出现超近距离的头像或身体，占据画面约 1/4 以上，且遮挡了后方展板、演讲者或主要活动场景。2. 画面严重模糊、抖动、过曝或欠曝，影响辨认人物和活动内容。3. 拍摄明显歪斜、人物构图非常杂乱，主体不清晰。4. 人物表情明显夸张、搞怪或不严肃，不适合严肃新闻平台。只要满足以上任一条，即使场景本身是活动现场，也必须标记为 AI rejected，并且绝对不能使用 AI recommended。只有在：没有任何 AI rejected 条件，且构图清晰、主题明确、背景简洁、主体无遮挡，能一眼看出活动主题和典型瞬间时，才可以使用 AI recommended。若照片质量中等但没有明显问题，可以不写 AI recommended 和 AI rejected。【输出格式（必须严格遵守）】只输出两行内容，不要输出任何多余文字、解释或空行。第 1 行：以“description=”开头（半角等号），后面是中文描述，描述 30字左右，语气客观、新闻口吻。示例：description=校园活动现场，学生在展板前认真交流，画面清晰，氛围庄重有序。换行：以“tags=[”开头，以“]”结尾，使用半角中括号，标签之间用英文逗号分隔，标签总数不超过 10 个。示例：tags=[AI rejected,中景,标准焦段,室外,多人,交流,青春,白天]。注意：description= 和 tags=[ ] 的符号全部使用英文半角，严禁在这两行之外输出任何其他内容。【标签选择规则】1. AI选片标签（若触发则必须放在第一个）：AI rejected 或 AI recommended 二选一，或都不写。2. 其他标签优先从以下词汇中选，按实际情况挑选，不必全部使用：镜头关系：特写,近景,中景,全景,远景（至少写一个）；焦段（必写一个）：长焦,标准焦段,超广角；场景：室内,室外,操场,教室,会议室；人物：人物,无人,单人,多人；动作：演讲,运动,鼓掌,交流；活动类型：讲座,运动会,出游,办公,上课,庆典；氛围：正式,严肃,庆祝,动感,青春,温馨,喜悦；时间：白天,黑夜（室内可省略）。3. 若画面还有非常突出的元素，上述标签未涵盖，可额外生成 0~3 个自定义标签，但总标签数不超过 10 个。",
      },
      {
        role: "user",
        content: [
          {
            // 关键：用 image_url + data URL，让服务端不再自己去拉图
            type: "image_url",
            image_url: { url: imageUrlForModel },
          },
          {
            type: "text",
            text:
              "请严格按照系统提示要求，仅输出两行结果：第一行为description=开头的中文描述（约30字），第二行为tags=[...]格式的标签列表。不要输出任何多余内容。",
          },
        ],
      },
    ],
  });

  // 兼容两种返回格式：content 可能是 string，也可能是数组
  const msg = resp.choices && resp.choices[0] && resp.choices[0].message;
  let raw = "";

  if (!msg) {
    raw = "";
  } else if (typeof msg.content === "string") {
    raw = msg.content.trim();
  } else if (Array.isArray(msg.content)) {
    raw = msg.content
      .map((p) => {
        if (typeof p === "string") return p;
        if (p && typeof p.text === "string") return p.text;
        if (p && typeof p.output_text === "string") return p.output_text;
        return "";
      })
      .join("")
      .trim();
  } else {
    raw = String(msg.content || "").trim();
  }

  // 解析 description 和 tags
  const lines = raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  let description = null;
  let tags = [];

  if (lines.length > 0) {
    const m = lines[0].match(/^description=(.*)$/i);
    if (m) description = m[1].trim();
  }

  if (lines.length > 1) {
    const m2 = lines[1].match(/^tags=\[(.*)\]$/i);
    if (m2) {
      tags = m2[1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }

  return { raw, description, tags };
}

// 模块导出：保留核心分析函数供其他模块调用（例如 ai_tags_worker）
module.exports = { analyze, headRequest, fetchBinary };

module.exports = { analyze, headRequest, fetchBinary };
