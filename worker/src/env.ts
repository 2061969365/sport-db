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
  SportDbAgent: DurableObjectNamespace<SportDbAgent>;
}
