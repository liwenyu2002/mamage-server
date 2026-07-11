// lib/news_fact_check.js 冒烟测试：人名一字之差 / 日期不符 / 地点弱提醒 / 数字改写 /
// 禁用词命中 / 图说拼装，全部纯本地断言，无需 DB、无需模型。
// 用法：node scripts/test_fact_check.js

const assert = require('assert');
const { checkFacts, checkForbiddenWords, generateCaptions } = require('../lib/news_fact_check');

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS  ${name}`);
  } catch (e) {
    console.error(`FAIL  ${name}`);
    console.error('      ', e && e.message ? e.message : e);
    process.exitCode = 1;
  }
}

// 1. 人名一字之差 -> 应报 suspect；精确匹配 -> 不应报
check('人名核对：一字之差报 issue，精确匹配不报', () => {
  const withTypo = checkFacts({
    markdown: '开幕式由李朋校长主持，现场气氛热烈。',
    form: {},
    personNames: ['李明'],
  });
  const nameIssues = withTypo.issues.filter((i) => i.type === 'name');
  assert.strictEqual(nameIssues.length, 1, '应报出 1 条人名 issue');
  assert.strictEqual(nameIssues[0].expect, '李明');
  assert.ok(nameIssues[0].found.includes('李朋'), 'found 应包含疑似错字候选');

  const exact = checkFacts({
    markdown: '开幕式由李明校长主持，现场气氛热烈。',
    form: {},
    personNames: ['李明'],
  });
  assert.strictEqual(exact.issues.filter((i) => i.type === 'name').length, 0, '精确匹配不应报 issue');
});

// 2. 日期不符 -> 报；日期一致 -> 不报
check('时间核对：日期不符报 issue，一致不报', () => {
  const mismatch = checkFacts({
    markdown: '活动于2026年7月11日在校园举行。',
    form: { eventDate: '2026-07-10' },
    personNames: [],
  });
  const dateIssues = mismatch.issues.filter((i) => i.type === 'date');
  assert.strictEqual(dateIssues.length, 1);
  assert.strictEqual(dateIssues[0].expect, '2026-07-10');
  assert.strictEqual(dateIssues[0].found, '2026年7月11日');

  const same = checkFacts({
    markdown: '活动于2026年7月10日在校园举行。',
    form: { eventDate: '2026-07-10' },
    personNames: [],
  });
  assert.strictEqual(same.issues.filter((i) => i.type === 'date').length, 0);
});

// 3. 地点弱提醒 -> 表单地点未在文中出现才报
check('地点核对：未出现报弱提醒，出现则不报', () => {
  const missing = checkFacts({
    markdown: '活动在操场举行，同学们热情参与。',
    form: { location: '大礼堂' },
    personNames: [],
  });
  const locIssues = missing.issues.filter((i) => i.type === 'location');
  assert.strictEqual(locIssues.length, 1);
  assert.strictEqual(locIssues[0].expect, '大礼堂');

  const present = checkFacts({
    markdown: '活动在大礼堂举行，同学们热情参与。',
    form: { location: '大礼堂' },
    personNames: [],
  });
  assert.strictEqual(present.issues.filter((i) => i.type === 'location').length, 0);
});

// 4. 数字被改写 -> 同上下文内数字不一致应报；数字一致不应报
check('数字抽查：同上下文数字被改写报 issue', () => {
  const changed = checkFacts({
    markdown: '本次活动参与学生130人，现场气氛热烈。',
    form: { participants: '', highlights: '参与学生120人现场氛围热烈' },
    personNames: [],
  });
  const numIssues = changed.issues.filter((i) => i.type === 'number');
  assert.strictEqual(numIssues.length, 1);
  assert.strictEqual(numIssues[0].expect, '120');
  assert.strictEqual(numIssues[0].found, '130');

  const unchanged = checkFacts({
    markdown: '本次活动参与学生120人，现场气氛热烈。',
    form: { participants: '', highlights: '参与学生120人现场氛围热烈' },
    personNames: [],
  });
  assert.strictEqual(unchanged.issues.filter((i) => i.type === 'number').length, 0);
});

// 5. 禁用词命中 -> 全部命中都要返回
check('禁用词校验：多次命中全部返回', () => {
  const { hits } = checkForbiddenWords('这是最好的活动，堪称第一，绝对最好。', ['最好', '第一']);
  assert.strictEqual(hits.length, 3, '最好命中2次+第一命中1次=3');
  assert.ok(hits.every((h) => typeof h.index === 'number' && h.snippet.includes(h.word)));
});

// 6. 图说拼装 -> 字段齐全 / 字段缺省 两种场景，长度都要 <=50
check('图说生成：字段齐全与缺省场景均 <=50 字', () => {
  const captions = generateCaptions({
    photos: [
      {
        id: 1,
        description: '同学们在操场上激烈地进行接力赛跑，气氛十分热烈。',
        personNames: ['张三', '李四', '王五', '赵六'],
        sectionName: '开幕式',
        photographerName: '陈老师',
      },
      {
        id: 2,
        description: '嘉宾合影留念',
      },
    ],
  });
  assert.strictEqual(captions.length, 2);

  const c1 = captions[0];
  assert.strictEqual(c1.photoId, 1);
  assert.ok(c1.caption.startsWith('图为张三、李四、王五等在开幕式环节'), c1.caption);
  assert.ok(c1.caption.endsWith('（摄影：陈老师）'), c1.caption);
  assert.ok(c1.caption.length <= 50, `长度=${c1.caption.length}: ${c1.caption}`);

  const c2 = captions[1];
  assert.strictEqual(c2.photoId, 2);
  assert.strictEqual(c2.caption, '图为嘉宾合影留念');
  assert.ok(c2.caption.length <= 50);
});

console.log(`\n${passed}/6 passed`);
if (process.exitCode) {
  console.error('存在失败用例');
} else {
  console.log('全绿');
}
