// Provider registry: providerID → provider entry. Adding a provider means
// adding one file under src/providers/ plus one line here; the core never
// changes. Unknown providers are simply absent — the hook leaves their retry
// decisions entirely to OpenCode's built-in policy.

import { zhipuaiCodingPlan } from "./providers/zhipuai-coding-plan.ts"
import type { ProviderEntry } from "./types.ts"

export const providerRegistry: Record<string, ProviderEntry> = {
  "zhipuai-coding-plan": zhipuaiCodingPlan,
}
