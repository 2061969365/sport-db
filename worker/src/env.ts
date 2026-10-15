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
  SportDbAgent: DurableObjectNamespace<SportDbAgent>;
}
