/**
 * 列表 / 下拉项**选中态**的样式约定。
 *
 * ## 为什么需要它
 *
 * 「选中项」是同一个视觉单元，但由**父子两层**共同表达：
 *
 * ```tsx
 * <div className={cn('...', selected && 'bg-accent-blue text-text-on-accent')}>
 *   <span>{name}</span>
 *   <span className={optionSecondary(selected)}>{command}</span>   // ← 这里
 * </div>
 * ```
 *
 * 父元素选中时底色变 accent 实底，子元素若自带 `text-text-muted` 会**覆盖继承**的
 * `text-text-on-accent` —— 暗色主题下灰字压在蓝底上几乎不可见。
 *
 * 这个错误在 6 个文件里重复出现过（`RemoteDialog` ×2、`WSLDialog` ×2、
 * `ProjectSettingsDialog` ×3），每次都是「加选中态时只改了父元素」。
 *
 * ## 为什么返回完整 class 而不是只返回颜色
 *
 * 7 处调用**完全同形** —— 都是次级文字（命令、路径），都是右对齐 + 小字号。
 * 只封装颜色的话，每个调用点还得自己写 `cn('ml-auto text-xs', ...)`，
 * 等于把「次级文字长什么样」这份知识复制 7 份。封装完整 class 后：
 *
 * ```tsx
 * // 只封颜色：布局知识仍散落 7 处
 * <span className={cn('ml-auto text-xs', colorOnly(selected))}>
 * // 封完整 class：布局 + 颜色都在唯一来源
 * <span className={optionSecondary(selected)}>
 * ```
 *
 * 判据与坑的完整说明见 `.trellis/spec/frontend/design-tokens.md` 坑 6；
 * 机器判据见 ESLint 规则 `neeko/ui/accent-foreground`。
 */

/**
 * 选中项里**次级文字**（命令、路径、计数）的完整 class。
 *
 * 用 80% 透明度的 on-accent 保留层级感 —— 与主文字（`text-text-on-accent`）
 * 形成主次对比，而不是同色一片。
 *
 * @param selected 该列表项是否处于选中态（父元素的 accent 底是否生效）
 */
export function optionSecondary(selected: boolean): string {
  return `ml-auto text-xs ${selected ? 'text-text-on-accent/80' : 'text-text-muted'}`;
}
