/**
 * 思考链解析器单元测试
 *
 * 重点验证：<think> / </think> 标签被 SSE 分片切断时的正确性
 * 运行：node --experimental-strip-types test/think-parser.test.ts
 */

import { ThinkParser, SafeBuffer, serializeMessages } from '../src/mimo/serialize.ts';

let passed = 0;
let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}`);
    console.log(`     期望: ${e}`);
    console.log(`     实际: ${a}`);
  }
}

/** 把一个完整字符串按给定分片喂入，返回累计结果 */
function feed(chunks: string[]): { reasoning: string; content: string } {
  const p = new ThinkParser();
  let reasoning = '';
  let content = '';
  for (const c of chunks) {
    const r = p.push(c);
    reasoning += r.reasoning;
    content += r.content;
  }
  return { reasoning, content };
}

console.log('\n=== ThinkParser 测试 ===\n');

// 1. 基本：单分片完整
console.log('[基本解析]');
check('单分片完整', feed(['<think>推理过程</think>最终答案']), {
  reasoning: '推理过程',
  content: '最终答案',
});

// 2. 无思考标签
check('无思考标签', feed(['直接回答']), { reasoning: '', content: '直接回答' });

// 3. <thinking> 变体
check('<thinking> 变体', feed(['<thinking>思考中</thinking>结果']), {
  reasoning: '思考中',
  content: '结果',
});

// 4. ★ 核心：标签被分片切断
console.log('\n[分片切断 - 关键场景]');
check('开头标签被切断', feed(['<thi', 'nk>推理', '</think>答案']), {
  reasoning: '推理',
  content: '答案',
});

check('结束标签被切断', feed(['<think>推理</thi', 'nk>答案']), {
  reasoning: '推理',
  content: '答案',
});

check('逐字符喂入', feed([...'<think>推理</think>答案']), {
  reasoning: '推理',
  content: '答案',
});

check('标签跨三分片', feed(['<th', 'in', 'k>思考内容', '</th', 'ink>', '输出']), {
  reasoning: '思考内容',
  content: '输出',
});

// 5. 尖括号被切断但不能误判
console.log('\n[边界情况]');
check('普通文本含 `<`', feed(['a < b 且 c > d']), {
  reasoning: '',
  content: 'a < b 且 c > d',
});

check('以 `<` 结尾后接普通文本', feed(['价格 <', ' 100 元']), {
  reasoning: '',
  content: '价格 < 100 元',
});

check('空字符串分片', feed(['', '<think>', '', '内容', '</think>', '', '尾部']), {
  reasoning: '内容',
  content: '尾部',
});

// 6. 思考段很长跨多片
check('思考段跨多片', feed(['<think>第一段', '第二段', '第三段</think>', '正文']), {
  reasoning: '第一段第二段第三段',
  content: '正文',
});

// 7. 未闭合（流中断）
check('未闭合思考段', feed(['<think>推理中', '被中断']), {
  reasoning: '推理中被中断',
  content: '',
});

// 8. 残留 <think> 清理
check('越过思考段后的残留标签', feed(['<think>a</think>正文<think>残留</think>后续']), {
  reasoning: 'a',
  content: '正文后续',
});

// 9. 空字符过滤
check('过滤 \\u0000', feed(['<think>推\u0000理</think>答\u0000案']), {
  reasoning: '推理',
  content: '答案',
});

// 10. thinkingDefaultOn 场景：思考后答案换行
check('结束标签后带换行', feed(['<think>推理</think>\n答案内容']), {
  reasoning: '推理',
  content: '答案内容',
});

console.log('\n=== SafeBuffer 测试 ===\n');

// SafeBuffer
const sb = new SafeBuffer(5);
check('缓冲不足不输出', sb.push('abc'), '');
check('超出部分输出', sb.push('defghij'), 'abcde');
check('flush 取剩余', sb.flush(), 'fghij');

const sb2 = new SafeBuffer(5);
let out = '';
out += sb2.push('hello world');
out += sb2.flush();
check('完整输出无丢失', out, 'hello world');

console.log('\n=== serializeMessages 测试 ===\n');

check(
  '基本序列化',
  serializeMessages([
    { role: 'system', content: '你是助手' },
    { role: 'user', content: '你好' },
  ]),
  '你是助手\n\n你好',
);

check(
  '含助手历史',
  serializeMessages([
    { role: 'user', content: '问题' },
    { role: 'assistant', content: '回答' },
    { role: 'user', content: '追问' },
  ]),
  '问题\n\n（你之前的回复）\n回答\n\n追问',
);

check('过滤空消息', serializeMessages([{ role: 'user', content: '  ' }]), '');

console.log(`\n${'='.repeat(40)}`);
console.log(`结果: ${passed} 通过, ${failed} 失败`);
console.log(`${'='.repeat(40)}\n`);

process.exit(failed > 0 ? 1 : 0);
