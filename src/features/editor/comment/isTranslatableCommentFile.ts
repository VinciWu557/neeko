/**
 * 该文件是否支持注释翻译（入口是否显示）。
 *
 * 判据 = 语法表里有注释节点名。**不在**这里维护扩展名清单 —— 那是
 * `languageRegistry`（`detectFamily`）的职责，本函数只是它的等价投影。
 *
 * 为什么需要它：`extractComments` 对 unknown 家族静默返回空，若入口不判，
 * 用户点了「翻译注释」什么也不会发生（静默失败，比不显示按钮更糟）。
 */
import { detectFamily } from './commentSyntax';

/** 该路径是否属于可翻译注释的语言家族。 */
export function isTranslatableCommentFile(filePath: string): boolean {
  return detectFamily(filePath) !== 'unknown';
}
