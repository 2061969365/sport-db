// 共享 Env 类型：vars + secrets + Agent binding。
// type-only 循环导入（env ↔ sport-agent），TS 允许，不影响运行时。
import type { SportDbAgent } from "./sport-agent";

export interface Env {
  REPO: string;
  VISION_ENDPOINT: string;
  VISION_MODEL: string;
  TG_BOT_TOKEN: string;
  TG_SECRET: string;
  GH_PAT?: string;
  FEISHU_APP_ID?: string;
  FEISHU_APP_SECRET?: string;
  /** 天气默认城市（如「上海」）；也可用 HOME_LAT/HOME_LON。 */
  HOME_CITY?: string;
  HOME_LAT?: string;
  HOME_LON?: string;
  /** 可选：配了就用 Tavily 搜索（返回 JSON，比解析 HTML 稳）。 */
  TAVILY_API_KEY?: string;
  /** 可选：AnySearch 凭据（不配走匿名，同样能用但额度低）。 */
  ANYSEARCH_API_KEY?: string;
  /** 可选：AnySearch 网关地址覆盖（默认 https://api.anysearch.com）。 */
  ANYSEARCH_BASE_URL?: string;
  /** 可选：备用模型网关（主网关 429/5xx/连不上时自动切过去，用户无感）。 */
  VISION_ENDPOINT_ALT?: string;
  VISION_MODEL_ALT?: string;
  ALT_API_KEY?: string;
  /** 可选：长期画像是否跨通道共享（默认 true；设 "false" 则各通道独立本机存储）。 */
  PROFILE_SHARED?: string;
  /**
   * 可选：状态备份改走独立（通常私有）仓 —— 换账号后提醒能自动恢复，
   * 以后要备份聊天记录也走这里，不会把私人对话放进公开仓。
   * 需要同时配 STATE_REPO（owner/repo）与 STATE_PAT。
   */
  STATE_REPO?: string;
  STATE_PAT?: string;
  /**
   * 网关流式是否可用：默认 "off"（走非流式 + 合成 SSE，绕过网关流式中断的毛病）；
   * 哪天网关修好了，设成 "on" 就恢复原生流式。
   */
  MODEL_STREAMING?: string;
  SportDbAgent: DurableObjectNamespace<SportDbAgent>;
}
