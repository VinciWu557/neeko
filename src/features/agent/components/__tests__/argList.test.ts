import { describe, expect, it } from 'vitest';

import { buildChatLaunch } from '../agentFormChat';
import { appendArg, removeArgAt, setArgAt, trimArgList } from '../argList';

/**
 * argv 列表的纯操作。
 *
 * # 为什么是数组而不是「一行文本」
 *
 * 旧实现把 `string[]` 投影成空格分隔的一行（`splitArgs`/`join(' ')`），该投影
 * **有损**：含空格的单个参数会被拆散。
 *
 * ```
 * ['--sys', 'hello world'] -> "--sys hello world" -> ['--sys','hello','world']
 * ```
 *
 * 关键在于它不幂等 —— 打开设置页再保存一次，用户的配置就变了，且没有任何报错。
 * 表单态直接持有 `string[]` 让这个投影根本不存在。
 */

describe('setArgAt', () => {
  it('should replace the value at an index without touching the others', () => {
    expect(setArgAt(['a', 'b', 'c'], 1, 'B')).toEqual(['a', 'B', 'c']);
  });

  /** 参数值可以是空串（`git commit -m ""`），编辑不应把它归一掉。 */
  it('should accept an empty string as a legitimate value', () => {
    expect(setArgAt(['a'], 0, '')).toEqual(['']);
  });

  it('should not mutate the input array', () => {
    const original = ['a', 'b'];
    setArgAt(original, 0, 'z');
    expect(original).toEqual(['a', 'b']);
  });

  it('should ignore an out-of-range index', () => {
    expect(setArgAt(['a'], 5, 'z')).toEqual(['a']);
  });
});

describe('appendArg', () => {
  it('should append one empty slot', () => {
    expect(appendArg(['a'])).toEqual(['a', '']);
  });

  it('should start a list from empty', () => {
    expect(appendArg([])).toEqual(['']);
  });

  it('should not mutate the input array', () => {
    const original: string[] = [];
    appendArg(original);
    expect(original).toEqual([]);
  });
});

describe('removeArgAt', () => {
  it('should remove the indexed entry', () => {
    expect(removeArgAt(['a', 'b', 'c'], 1)).toEqual(['a', 'c']);
  });

  it('should allow removing down to empty', () => {
    expect(removeArgAt(['a'], 0)).toEqual([]);
  });

  it('should not mutate the input array', () => {
    const original = ['a', 'b'];
    removeArgAt(original, 0);
    expect(original).toEqual(['a', 'b']);
  });

  it('should ignore an out-of-range index', () => {
    expect(removeArgAt(['a'], 9)).toEqual(['a']);
  });
});

describe('trimArgList', () => {
  /**
   * 用户点「+ Add」后常常直接保存 —— 尾部空行是**未填**,不是「一个空参数」。
   * 只裁尾部：中间的 `''` 是用户明确要的空参数，必须保留。
   */
  it('should drop trailing empty slots only', () => {
    expect(trimArgList(['a', 'b', '', ''])).toEqual(['a', 'b']);
  });

  it('should keep an empty slot that sits between values', () => {
    expect(trimArgList(['a', '', 'b'])).toEqual(['a', '', 'b']);
  });

  it('should return an empty list when everything is blank', () => {
    expect(trimArgList(['', ''])).toEqual([]);
  });

  it('should leave a fully populated list untouched', () => {
    expect(trimArgList(['a', 'b'])).toEqual(['a', 'b']);
  });

  /** 空白串与空串同义：都表示「这一行没填」。 */
  it('should treat whitespace-only trailing slots as unfilled', () => {
    expect(trimArgList(['a', '   '])).toEqual(['a']);
  });
});

/**
 * **不变量**：数组态不存在投影，因此任意 argv 都能原样往返。
 *
 * 这条测试是方案 C 的存在理由 —— 旧投影（`join(' ')` → `split(/\s+/)`）
 * 在这三种输入上全部失真。
 */
describe('argv round-trip invariant', () => {
  const cases: string[][] = [
    ['--sys', 'hello world'],
    ['a', '', 'b'],
    ['x y'],
    ["it's", 'a"b'],
    ['$HOME/kept', '*.ts-kept'],
    [],
  ];

  it.each(cases.map((argv, i) => [i, argv] as const))(
    'should preserve case %i exactly',
    (_index, argv) => {
      // 数组即真值：经过一次 set/remove 往返后仍相等。
      const after = removeArgAt(setArgAt(argv, 0, argv[0] ?? ''), argv.length);
      expect(after).toEqual(argv);
    },
  );
});

/**
 * **判据必须与落库值同源**（历史缺陷）。
 *
 * 表单早期用 `chatArgv.length > 0` 判断「有没有 CHAT 能力」，而真正落库用的是
 * `trimArgList(chatArgv)`。两者只在「槽位全是空白」时结论相反：
 *
 * ```
 * chatArgv = ['   '] → length > 0     ⇒ 预览显示「有 CHAT」
 * trimArgList → []   ⇒ chat = null    ⇒ 实际没有任何能力
 * ```
 *
 * 后果：表单声称有 CHAT，提交后 agent 的 CLI / CHAT / Headless 全为空，
 * 且没有任何报错。现在判据改为 `buildChatLaunch(...) !== null`，
 * 与落库值必然一致 —— 本用例锁住这条等价性。
 */
describe('chat capability predicate matches the persisted value', () => {
  const cases: [string, string[], boolean, boolean][] = [
    ['blank slots only', ['   '], false, false],
    ['single empty slot', [''], false, false],
    ['real program', ['opencode'], false, true],
    ['program with blank tail', ['opencode', ''], false, true],
    ['in-process flag', [], true, true],
  ];

  it.each(cases)('%s', (_name, chatArgv, inprocess, expected) => {
    const persisted = buildChatLaunch(trimArgList(chatArgv), '', inprocess);
    expect(persisted !== null).toBe(expected);
    // 空 argv 且未声明 inprocess 时，落库必须是 null 而不是 { program: '' }.
    if (!expected) expect(persisted).toBeNull();
  });
});
