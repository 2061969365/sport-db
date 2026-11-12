// 把 view_repo_image 工具结果里的 @@IMG@@<url> 变成真正的图片部件。
//
// 为什么不在工具里直接返回图片：@cloudflare/think 的工具结果图片在当前网关
// 收不到（模型会说"传过来的是链接"），addMessages 中途写入也不会进入本轮请求
// （实测 imgs 恒为 0）。所以在发请求前、在原始 body 上补一条 user 图片消息。
export interface InjectResult {
  body: string | null;
  injected: number;
}

const MARKER = /@@IMG@@(https:\/\/\S+)/;

export function injectImageParts(bodyText: string | null): InjectResult {
  if (!bodyText) return { body: bodyText, injected: 0 };
  let b: {
    messages?: { role?: string; content?: unknown }[];
  };
  try {
    b = JSON.parse(bodyText) as typeof b;
  } catch {
    return { body: bodyText, injected: 0 };
  }
  if (!Array.isArray(b?.messages)) return { body: bodyText, injected: 0 };

  const already = new Set<string>();
  for (const m of b.messages) {
    if (!Array.isArray(m.content)) continue;
    for (const p of m.content as { type?: string; image_url?: { url?: string } }[]) {
      if (p?.type === "image_url" && p?.image_url?.url) already.add(String(p.image_url.url));
    }
  }

  let injected = 0;
  // 只看最近 4 条：历史里的旧标记不该让此后每一轮都重发图片。
  const recent = b.messages.slice(-4);
  for (const m of recent) {
    const txt = typeof m.content === "string"
      ? m.content
      : Array.isArray(m.content)
        ? (m.content as { text?: string }[]).map((p) => p?.text || "").join(" ")
        : "";
    const hit = MARKER.exec(txt);
    if (!hit || already.has(hit[1])) continue;
    b.messages.push({
      role: "user",
      content: [
        { type: "text", text: "（这是他让你看的那张图，直接看画面回答）" },
        { type: "image_url", image_url: { url: hit[1] } },
      ],
    });
    already.add(hit[1]);
    injected++;
  }
  return { body: injected ? JSON.stringify(b) : bodyText, injected };
}

/** 这个 body 里有没有图片部件（用于决定 400 是否值得重试）。 */
export function hasImagePart(bodyText: string | null): boolean {
  return !!bodyText && /"type":\s*"image_url"|@@IMG@@/.test(bodyText);
}

/** 请求体里真正带了几张图（image_url 部件），用于决定是否换视觉模型。 */
export function countImageParts(bodyText: string | null): number {
  if (!bodyText) return 0;
  const re = /"type":\s*"image_url"/g;
  return (bodyText.match(re) || []).length;
}
