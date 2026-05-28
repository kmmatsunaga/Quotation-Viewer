/**
 * Google Gemini API クライアント (薄ラッパ)
 *
 * モデル選択:
 *   - gemini-2.5-flash : 高速・低コスト (ニュース1件分類向け)
 *   - gemini-2.5-pro   : 高精度 (長文IR資料/複数記事まとめ向け)
 *
 * 認証: GEMINI_API_KEY 環境変数 (Vercel env)
 *   セット方法: printf '%s' "AIza..." | npx vercel env add GEMINI_API_KEY production
 *
 * REST 仕様:
 *   POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={KEY}
 *   body: { contents: [{ parts: [{ text: prompt }] }], generationConfig: {...} }
 */

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

export type GeminiModel = "gemini-2.5-flash" | "gemini-2.5-pro";

export interface GeminiOptions {
  model?: GeminiModel;
  temperature?: number;       // 0-2 (デフォルト1.0)
  maxOutputTokens?: number;   // デフォルト 2048
  responseMimeType?: "text/plain" | "application/json";
  systemInstruction?: string;
}

export interface GeminiResponse {
  text: string;
  finishReason?: string;
  usage?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

/**
 * Gemini に1回のプロンプトを投げてテキストを取得。
 * エラー時は throw。
 */
export async function geminiGenerate(prompt: string, options: GeminiOptions = {}): Promise<GeminiResponse> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not set. Set it via Vercel env or .env.local");
  }
  const model = options.model ?? "gemini-2.5-flash";
  const url = `${ENDPOINT}/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    ...(options.systemInstruction
      ? { systemInstruction: { parts: [{ text: options.systemInstruction }] } }
      : {}),
    generationConfig: {
      temperature: options.temperature ?? 0.7,
      maxOutputTokens: options.maxOutputTokens ?? 2048,
      ...(options.responseMimeType ? { responseMimeType: options.responseMimeType } : {}),
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Gemini API error ${res.status}: ${errText.slice(0, 300)}`);
  }

  const json = await res.json();
  const candidate = json?.candidates?.[0];
  const text =
    candidate?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ?? "";

  return {
    text: text.trim(),
    finishReason: candidate?.finishReason,
    usage: json?.usageMetadata
      ? {
          promptTokenCount: json.usageMetadata.promptTokenCount,
          candidatesTokenCount: json.usageMetadata.candidatesTokenCount,
          totalTokenCount: json.usageMetadata.totalTokenCount,
        }
      : undefined,
  };
}

/**
 * JSON モードで構造化レスポンスを取得。
 * Gemini が壊れた JSON を返しても緩めにパース。
 */
export async function geminiGenerateJson<T = unknown>(
  prompt: string,
  options: Omit<GeminiOptions, "responseMimeType"> = {}
): Promise<{ data: T; raw: string; usage?: GeminiResponse["usage"] }> {
  const res = await geminiGenerate(prompt, { ...options, responseMimeType: "application/json" });
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.text);
  } catch {
    // Markdown コードブロックなど抜き出してリトライ
    const m = res.text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (m) {
      parsed = JSON.parse(m[1]);
    } else {
      throw new Error(`Gemini returned non-JSON: ${res.text.slice(0, 200)}`);
    }
  }
  return { data: parsed as T, raw: res.text, usage: res.usage };
}
