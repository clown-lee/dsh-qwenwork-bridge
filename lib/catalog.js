/**
 * 千问办公的模型清单。
 *
 * 上游没有 `GET /v1/models`（实测 404），模型清单只存在于桌面端自己的
 * `chat-modes-v2` 目录响应里，所以这里内置一份快照，并允许在运行时被一次
 * 成功的目录拉取覆盖。
 *
 * @module dsh-qwenwork-bridge/catalog
 */

/** 所有模型的输入上限都报这个值（目录响应里的 `max_input_tokens` 一致为 1e6）。 */
const MAX_INPUT_TOKENS = 1_000_000

/** 输出上限目录没给，按各家网关的常见值给一个保守数字。 */
const MAX_OUTPUT_TOKENS = 65_536

/**
 * 内置快照。
 *
 * `name` 是桌面端模型选择器里显示的名字；`id` 是上游 `model` 字段要的值。
 * `cost` 一律 0：这些模型走的是订阅额度，没有可换算的单价。
 */
const BUILTIN_MODELS = Object.freeze([
  { id: 'flash', name: 'Flash', reasoning: true, vision: true, priceFactor: 0.1 },
  { id: 'pro', name: 'Pro', reasoning: true, vision: false, priceFactor: 1.0 },
  { id: 'qwen4-max', name: 'Qwen4-Max', reasoning: true, vision: true, priceFactor: 1.6 },
  { id: 'qwen3.8-max-preview', name: 'Qwen3.8-Max', reasoning: true, vision: true, priceFactor: 1.8 },
  { id: 'qwen3.8-flash', name: 'Qwen3.8-Flash', reasoning: true, vision: true, priceFactor: 0.1 },
  { id: 'glm-5.4', name: 'GLM-5.4', reasoning: true, vision: false, priceFactor: 1.2 },
  { id: 'ling-3.1-flash', name: 'Ling-3.1-Flash', reasoning: true, vision: false, priceFactor: 0.1 },
  { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', reasoning: true, vision: true, priceFactor: 0.1 },
  { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', reasoning: true, vision: false, priceFactor: 0.2 },
  { id: 'glm-5.3', name: 'GLM-5.3', reasoning: true, vision: false, priceFactor: 1.2 },
  { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', reasoning: true, vision: false, priceFactor: 0.2 },
  { id: 'kimi-k3.1-pro', name: 'Kimi-K3.1-Pro', reasoning: true, vision: true, priceFactor: 2.4 },
  { id: 'minimax-m3.1-flash', name: 'MiniMax-M3.1-Flash', reasoning: true, vision: true, priceFactor: 0.2 },
  { id: 'step-5-preview', name: 'Step-5-Preview', reasoning: true, vision: true, priceFactor: 0.7 },
])

/**
 * 把内置快照翻成统一形状。
 * @param entry - `BUILTIN_MODELS` 的一项。
 */
function toModelInfo(entry) {
  return {
    id: entry.id,
    name: entry.name,
    reasoning: entry.reasoning,
    // 上游确实收 image_url（实测 200），但 pi-ai 要真正路由图片得靠宿主的
    // durable attachment service，插件的 provider 拿不到那个服务 —— 声明
    // `image` 会让发图直接抛 "pi-ai image input requires the durable
    // attachment service"。所以这里一律只报 text。
    input: ['text'],
    contextWindow: MAX_INPUT_TOKENS,
    maxTokens: MAX_OUTPUT_TOKENS,
    priceFactor: entry.priceFactor,
  }
}

/** 内置清单的完整形状。 */
export function builtinCatalog() {
  return BUILTIN_MODELS.map(toModelInfo)
}

/**
 * 从 `chat-modes-v2` 目录响应里抽模型清单。
 *
 * 响应形状（截断）：
 * ```json
 * { "modes": [ { "id": "flash", "name": "标准", "model": "flash",
 *                "max_input_tokens": 1000000, "is_reasoning": true,
 *                "is_vl": true, "price_factor": 0.1 } ] }
 * ```
 * 字段名在不同版本里漂过（`model`/`model_id`、`name`/`display_name`），所以
 * 这里对每种都做一次兜底。认不出的条目直接跳过，不猜。
 * @param body - 目录响应。
 */
export function normalizeCatalog(body) {
  const list = Array.isArray(body?.modes)
    ? body.modes
    : Array.isArray(body?.data?.modes)
      ? body.data.modes
      : Array.isArray(body?.models)
        ? body.models
        : []
  const out = []
  const seen = new Set()
  for (const entry of list) {
    if (entry === null || typeof entry !== 'object') continue
    const id = firstString(entry.model, entry.model_id, entry.id)
    if (id === undefined || seen.has(id)) continue
    seen.add(id)
    const name = firstString(entry.display_name, entry.name) ?? id
    const vision = entry.is_vl === true || entry.vision === true
    const contextWindow = firstPositiveInt(entry.max_input_tokens, entry.context_window, entry.context_window_size?.default) ?? MAX_INPUT_TOKENS
    const maxTokens = firstPositiveInt(entry.max_output_tokens, entry.max_tokens) ?? MAX_OUTPUT_TOKENS
    out.push({
      id,
      name,
      reasoning: entry.is_reasoning === true || entry.reasoning === true,
      // 同 toModelInfo：即使目录标了 is_vl 也只报 text，见上面的说明。
      vision,
      input: ['text'],
      contextWindow,
      maxTokens,
      priceFactor: typeof entry.price_factor === 'number' ? entry.price_factor : 1,
    })
  }
  return out
}

/** 第一个非空字符串。 */
function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/** 第一个正整数。 */
function firstPositiveInt(...values) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.trunc(value)
  }
  return undefined
}

/**
 * 模型目录：内置快照 + 可被一次成功的拉取覆盖。
 */
export class QwenworkCatalog {
  /** @param logger - 可选日志。 */
  constructor(logger) {
    this.logger = logger
    /** @type {ReturnType<typeof builtinCatalog>} */
    this.models = builtinCatalog()
    /** `builtin` 或 `live`。 */
    this.source = 'builtin'
    /** 最近一次成功拉取的时刻。 */
    this.fetchedAtMs = 0
    /** 最近一次失败原因。 */
    this.error = undefined
  }

  /** 当前清单。 */
  current() {
    return this.models
  }

  /** 按 id 找模型；找不到返回 undefined。 */
  find(id) {
    return this.models.find((model) => model.id === id)
  }

  /**
   * 用一份新清单替换内置快照。
   *
   * 空清单**不覆盖**：上游偶尔会回一个空 modes 数组，那时候继续用内置的更靠谱。
   * @returns 是否真的变了。
   */
  setModels(models) {
    if (!Array.isArray(models) || models.length === 0) return false
    const signature = (list) => list.map((model) => `${model.id}:${model.name}`).join('|')
    const changed = signature(models) !== signature(this.models)
    this.models = models
    this.source = 'live'
    this.fetchedAtMs = Date.now()
    this.error = undefined
    return changed
  }

  /** 记一次失败，不清空清单。 */
  fail(error) {
    this.error = error instanceof Error ? error.message : String(error)
  }

  /** 回到内置快照（登出时用）。 */
  reset() {
    const changed = this.source !== 'builtin'
    this.models = builtinCatalog()
    this.source = 'builtin'
    this.fetchedAtMs = 0
    this.error = undefined
    return changed
  }
}
