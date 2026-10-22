import type { ModelInfo } from '@/shared/types/agent';
import type { ConfigCapability } from '@/shared/types/agentChat';

/**
 * 模型列表的**可用状态** —— 一个 4 态 union，不是 `phase × capability` 的笛卡尔积。
 *
 * # 第一性原理：真实的可能世界只有四个
 *
 * | 状态 | 传输 | 会话就绪 | 模型列表来源 | 可写 |
 * | --- | --- | --- | --- | --- |
 * | `no-config`   | `None`     | —      | 会话外目录（若无） | ✗ 永久 |
 * | `per-turn`    | `PerTurn`  | —      | 会话外目录 | ✓ 走每轮请求参数 |
 * | `pending`     | `SessionConfig` | 否 | 会话外目录（若无） | ✗ 暂时 |
 * | `ready`       | `SessionConfig` | 是 | 会话内 `configOptions` | ✓ 走 `set_config_option` |
 *
 * `{phase: 'ready', capability: 'none'}` 这类组合**不可达**：`phase` 的定义就是
 * `!supported ? 'unsupported' : ...`，`none` 永远是 `unsupported`。
 *
 * 早期实现把它写成两个字段的自由组合，于是每个消费点都要自己 switch 两个维度 ——
 * 4 处判据各自推导，自然漂移。收成一个 union 后：
 *
 * - **非法状态在类型层无法表达**；
 * - 每个判据都是该 union 上的**全函数**，`switch` 穷举、编译器强制处理新状态。
 *
 * # 与后端的关系
 *
 * 后端 `ChatCapabilities::config` 是**权威声明**；本类型是「声明 + 会话就绪度」
 * 的前端合成。映射只有一处（[`modelAvailabilityOf`]），消费方不重复推导。
 */
export type ModelAvailability =
  /** 传输没有会话配置通道，也没有每轮模型参数 —— 模型选择无意义。 */
  | 'no-config'
  /** 模型随每轮请求下发（serve）。列表来自会话外目录，**不产生**配置项回推。 */
  | 'per-turn'
  /** 传输支持会话配置项，但会话尚未就绪（握手未完成）。 */
  | 'pending'
  /** 会话就绪，列表来自 `configOptions`（权威）。 */
  | 'ready';

/**
 * 由后端能力位 + 会话配置项三态合成本类型的**唯一**入口。
 *
 * # 为什么是唯一入口
 *
 * 之前有两个入口（`modelSourceOf` 给写回用、`modelWritabilityOf` 给渲染用），
 * 各自 switch 同一份输入 —— 两份实现必然漂移。现在一个入口、一个 union，
 * 所有判据都从它派生。
 */
export function modelAvailabilityOf(
  config: ConfigCapability,
  phase: 'unsupported' | 'loading' | 'ready',
): ModelAvailability {
  // 能力位优先于就绪度：`none` 传输即便 phase 报 `ready` 也不可写
  //（那只能是切换 agent 时残留的选项，见 design.md P3 修正）。
  if (config === 'none') return 'no-config';
  if (config === 'per_turn') return 'per-turn';
  // 走到这里 `config === 'session_config'`
  return phase === 'ready' ? 'ready' : 'pending';
}

/**
 * 模型选择器**是否显示**。
 *
 * `no-config` 隐藏（点了也没任何通道），其余都显示 —— 不可写时禁用并给出原因，
 * 而不是凭空消失（用户至少要知道「这台机器装了哪些模型」）。
 */
export function showsModelPicker(a: ModelAvailability): boolean {
  return a !== 'no-config';
}

/**
 * 可写性**三态**：`'loading'` 是暂时的、`'read-only'` 是上限。
 *
 * 用布尔会丢掉这层信息，用户看到一串灰模型无法区分二者。
 */
export type ModelWritability = 'writable' | 'loading' | 'read-only';

/** 该状态下列表的可写性。 */
export function writabilityOf(a: ModelAvailability): ModelWritability {
  switch (a) {
    case 'ready':
    case 'per-turn':
      return 'writable';
    case 'pending':
      return 'loading';
    case 'no-config':
      return 'read-only';
  }
}

/**
 * 写回目标（**类型层的可写性证明**：拿到它就一定能写）。
 *
 * 不存在 `read_only` 变体 —— 不可写时 [`modelWriteOf`] 返回 `null`，
 * 所以「拿到 write 却写不了」在类型上无法表达。
 */
export type ModelWrite =
  /** 写回会话配置项的 `select` value（`set_config_option`）。 */
  | { readonly kind: 'config_value'; readonly value: string }
  /** 随每轮请求下发（`Turn { model_id }`）。 */
  | { readonly kind: 'turn_param'; readonly id: string };

/** 把一条 `ModelInfo` 解析成写回目标；不可写时返回 `null`。 */
export function modelWriteOf(a: ModelAvailability, model: ModelInfo): ModelWrite | null {
  switch (a) {
    case 'ready':
      return { kind: 'config_value', value: model.id };
    case 'per-turn':
      return { kind: 'turn_param', id: model.id };
    case 'no-config':
    case 'pending':
      // `pending` 也写不了：此刻还没有会话配置项可改，而目录 id 的形状
      //（`provider/model`）喂给 `set_config_option` 会被 agent 拒绝。
      return null;
  }
}

/**
 * 模型条目的**唯一**组合键（React key / 选中判定）。
 *
 * Pi 的 224 条模型只有 194 个唯一 id（同名出现在多个 provider 下），
 * 所以必须与 `group` 组合。**无 group 时就是裸 id** —— 不带分隔符，
 * 否则同一条目在「有/无 group」两种表示下会得到不同 key。
 */
export function modelKeyOf(model: ModelInfo): string {
  return model.group ? `${model.id}|${model.group}` : model.id;
}

/**
 * 按**裸 id** 在列表里定位模型 —— 歧义消解的唯一入口。
 *
 * # 为什么不能直接 `models.find(m => m.id === id)`
 *
 * 模型的身份是 `(id, group)` 二元组（[`modelKeyOf`]），但会话只能回推**裸 id**
 * —— `configOptions.current_value` 与历史记录里的 `model` 都是单个字符串，
 * `group` 不参与。于是「会话说它在用 `deepseek-v4-pro`」面对 4 条同名条目时，
 * 直接 `find` 结果取决于**数组顺序**，不是任何人的选择。
 *
 * 后果很具体：用户在 provider A 下选了它，会话回推同一个裸 id → 按顺序命中
 * provider B 那条 → 高亮**跳到另一行**，而实际跑的没变。
 *
 * # 消解规则
 *
 * 1. 唯一命中 → 就它；
 * 2. 多条同名且 `current` 是其中一条 → **保留当前这条**（用户的身份不跳行）；
 * 3. 多条同名且 `current` 不在其中 → 取第一条（顺序即 agent 下发的优先序）。
 *
 * 规则 2 是这个函数的全部价值：没有它，只要列表里有重名，UI 就会自己乱跳。
 *
 * 注：会话侧**无法**告诉我们是哪个 group（协议只给字符串）。所以「跟随会话换
 * 模型」在重名时天生有歧义；上面的规则是「歧义时宁可不动」的最小伤害方案。
 * 这也是 `shared/types/agent.ts` 不再声称「选中判定用组合键」的原因 ——
 * 那个声明在回推方向不可实现，属「声明了却没人实现」。
 */
export function resolveModelById(
  models: ModelInfo[],
  id: string,
  current?: ModelInfo | null,
): ModelInfo | undefined {
  const matches = models.filter((m) => m.id === id);
  if (matches.length <= 1) return matches[0];
  if (current) {
    const key = modelKeyOf(current);
    const kept = matches.find((m) => modelKeyOf(m) === key);
    if (kept) return kept;
  }
  return matches[0];
}

/** 列表里是否存在这个裸 id 的模型（同名多条也算存在）。 */
export function hasModelId(models: ModelInfo[], id: string): boolean {
  return models.some((m) => m.id === id);
}
