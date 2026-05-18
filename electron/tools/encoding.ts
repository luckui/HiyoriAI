/**
 * 智能输出解码：优先 UTF-8，检测到无效序列时自动回退 GBK。
 *
 * 背景：
 *   - 中文 Windows OEM 编码是 GBK（CP936）
 *   - cmd.exe 内置命令（dir/type/echo）和部分老旧 Windows 程序输出 GBK 字节
 *   - 现代工具（git/npm/node/Python+PYTHONUTF8=1）输出 UTF-8
 *   - Node.js 直接用 'utf8' 读 GBK 字节 → 替换字符（\uFFFD）→ 乱码
 *
 * 原理：
 *   1. 先尝试 UTF-8 解码
 *   2. 若含有 \uFFFD（无效 UTF-8 序列的替换符）→ 改用 TextDecoder('gbk')
 *   3. TextDecoder 是 Node.js 内置全局，无需额外依赖
 */
export function decodeBuffer(buf: Buffer): string {
  const utf8 = buf.toString('utf8');
  // 无替换字符 → 是合法 UTF-8，直接返回
  if (!utf8.includes('\uFFFD')) return utf8;
  // 有替换字符 → 原始字节不是合法 UTF-8，尝试 GBK
  try {
    return new TextDecoder('gbk').decode(buf);
  } catch {
    return utf8; // 兜底：至少返回可读的内容
  }
}
