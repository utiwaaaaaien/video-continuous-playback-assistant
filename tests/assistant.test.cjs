const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {resolve} = require('node:path');
const {JSDOM} = require('jsdom');
const root = resolve(__dirname, '../extension');
const sources = ['core.js', 'ui.js', 'content.js'].map(name => readFileSync(resolve(root, name), 'utf8'));
const welcomeText = '温馨提示欢迎进入学习，建议保持当前页面观看视频，若切换窗口会影响您的考核计时～今日不再提示知道了';

async function fixture({last = false, rejectPlay = false, enabled = false, complete = false, nextCourse = false, nextDisabled = false, navigate = true, stored = null, url = 'https://estudy.enaea.edu.cn/web/player/project?project_id=p&course_id=c&resource_id=1', saveFails = false, initialTime = 0, networkErrorCode = null} = {}) {
  const dom = new JSDOM(`<body><main><header>${nextCourse ? `<span class="next-btn_HASH" ${nextDisabled ? 'aria-disabled="true"' : ''}>下一个课程<span class="icon-next"></span></span>` : ''}</header><div class="xgplayer"><video src="${stored ? 'blob:restored' : 'blob:first'}"></video></div><aside>${['一', '二', '三'].map((n, i) => `<div class="item-wrap_HASH" data-checked="${i === (last ? 2 : 0)}"><div class="item-title_HASH"><span class="name-span_HASH">第${n}集 标题</span><div class="rate-wrap_HASH">${complete ? '完成' : '0%'}</div></div><div class="item-info_HASH">04 分 27 秒</div></div>`).join('')}</aside></main></body>`, {url, runScripts: 'outside-only', pretendToBeVisual: true});
  const w = dom.window;
  let time = initialTime, serial = 0;
  const scheduled = new Map();
  const messages = [];
  const handlers = [];
  const feedbackHandlers=[];
  let manualStore=stored?.manualRecovery || null;
  const originalListen=w.document.addEventListener.bind(w.document);
  w.document.addEventListener=(name,fn,...options)=>{if(['pointerdown','keydown','input'].includes(name))feedbackHandlers.push(fn);return originalListen(name,fn,...options);};
  w.Date.now = () => time;
  w.setTimeout = (callback, ms) => {scheduled.set(++serial, {at: time + ms, callback}); return serial;};
  w.clearTimeout = id => scheduled.delete(id);
  w.setInterval = () => 0;
  w.crypto.randomUUID = () => 'test-document';
  Object.defineProperty(w.Element.prototype, 'getClientRects', {value() {
    for (let e = this; e; e = e.parentElement) if (e.hidden || e.style.display === 'none') return [];
    return [{width: 640, height: 360}];
  }});
  w.Element.prototype.getBoundingClientRect = () => ({width: 640, height: 360});
  w.chrome = {runtime: {
    sendMessage: async msg => {
      messages.push(msg);
      if (saveFails) return {error:'failed'};
      if (msg.type==='assistant:get-session') return stored || {course:'p:c',enabled,autoConfirm:true};
      if (msg.type==='assistant:save-session') manualStore=msg.state.manualRecovery?{...msg.state.manualRecovery}:null;
      if (msg.type==='assistant:recover-now') {
        if (!manualStore || manualStore.id!==msg.jobId || manualStore.stage!=='waiting' || manualStore.attempted || manualStore.feedback || time<manualStore.dueAt) return {ok:false};
        manualStore={...manualStore,stage:'checking',attempted:true,checkUntil:time+60000};
        messages.push({type:'test:reload'});return {ok:true,job:{...manualStore}};
      }
      return {ok:true,active:msg.playing===true};
    },
    onMessage: {addListener(fn) {handlers.push(fn);}}
  }};
  function prepare(v) {
    v.media = {paused: true, ended: false, ready: 4, playCount: 0, time: 10, duration: 60, error: networkErrorCode ? {code:networkErrorCode} : null};
    Object.defineProperties(v, {error: {get: () => v.media.error}, paused: {get: () => v.media.paused}, ended: {get: () => v.media.ended}, readyState: {get: () => v.media.ready}, currentSrc: {get: () => v.getAttribute('src')}, currentTime: {get: () => v.media.ended ? v.media.duration : v.media.time}, duration: {get: () => v.media.duration}});
    v.pause = () => {v.media.paused=true;v.dispatchEvent(new w.Event('pause'));};
    v.play = async () => {v.media.playCount++; if (rejectPlay) throw new Error('NotAllowedError'); v.media.paused = false; v.dispatchEvent(new w.Event('playing'));};
    return v;
  }
  let v = prepare(w.document.querySelector('video'));
  let clicks = 0;
  let courseClicks = 0;
  const rows = [...w.document.querySelectorAll('[class*=item-wrap_]')];
  function select(index) {
    rows.forEach((row, i) => row.dataset.checked = String(i === index));
    w.history.replaceState({}, '', `?project_id=p&course_id=c&resource_id=${index + 1}`);
    v.setAttribute('src', `blob:episode${index + 1}`);
    v.media.ended = false;
    v.media.paused = true;
    v.dispatchEvent(new w.Event('loadedmetadata'));
  }
  rows.forEach((row, index) => row.addEventListener('click', () => {clicks++; select(index);}));
  function arrive({scope = 'p', updateSource = true} = {}) {
    w.history.replaceState({}, '', `?project_id=${scope}&course_id=next&resource_id=new`);
    rows.forEach((row, index) => {
      row.dataset.checked = String(index === 0);
      row.querySelector('[class*=name-span_]').textContent = `新课程第${index + 1}集`;
      row.querySelector('[class*=rate-wrap_]').textContent = '0% 01 分 00 秒';
    });
    if (updateSource) v.setAttribute('src', 'blob:new-course');
    v.media.ended = false; v.media.paused = true;
    v.dispatchEvent(new w.Event('loadedmetadata'));
  }
  // Keep names in the site's episode format so the adapter can discover them.
  function adaptNames() { rows.forEach((row, index) => {row.querySelector('[class*=name-span_]').textContent = `第${['一', '二', '三'][index]}集 新课程`;}); }
  w.document.querySelector('[class*=next-btn_]')?.addEventListener('click', () => {courseClicks++; if (navigate) {arrive(); adaptNames();}});
  w.__testReload = () => messages.push({type:'test:reload'});
  sources.forEach(source => w.eval(source.replace('location.reload();','globalThis.__testReload();')));
  async function flush() {for (let i = 0; i < 12; i++) await Promise.resolve();}
  await flush();
  async function advance(ms) {
    const end = time + ms;
    for (let rounds = 0; rounds < 500; rounds++) {
      await flush();
      const entry = [...scheduled.entries()].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!entry) break;
      scheduled.delete(entry[0]); time = entry[1].at; entry[1].callback();
    }
    time = end; await flush();
  }
  function control(action, options = {}) {
    let result;
    handlers[0]({type: 'assistant:control', action, ...options}, {}, value => {result = value;});
    return result;
  }
  function ended() {v.media.ended = true; v.media.paused = true; v.dispatchEvent(new w.Event('ended'));}
  function dialog(text, input = false) {
    const node = w.document.createElement('div'); node.setAttribute('role', 'dialog');
    node.innerHTML = `<p>${text}</p>${input ? '<input type="radio">' : ''}<button>确定</button>`;
    w.document.body.append(node); return node;
  }
  return {w, control, advance, ended, dialog, select, messages, feedback(){feedbackHandlers.forEach(fn=>fn({isTrusted:true}));}, get manualStore(){return manualStore;}, arrive(options) {arrive(options); adaptNames();}, get courseClicks() {return courseClicks;}, get video() {return v;}, get clicks() {return clicks;}, close: () => w.close(), replaceVideo() {
    const replacement = prepare(w.document.createElement('video')); replacement.setAttribute('src', v.getAttribute('src')); v.replaceWith(replacement); v = replacement;
  }};
}

test('仅在自然结束时切集；暂停不触发切集；重复结束只点击一次', async () => {
  const f = await fixture(); f.control('start'); f.video.dispatchEvent(new f.w.Event('pause')); await f.advance(3000); assert.equal(f.clicks, 0);
  f.ended(); f.ended(); await f.advance(2300); assert.equal(f.clicks, 1); assert.equal(f.control('status').phase, 'playing'); assert.equal(f.video.media.playCount, 1); f.close();
});
test('网站先自动切集时，助手不会再跳一集', async () => {
  const f = await fixture(); f.control('start'); f.ended(); f.select(1); await f.advance(2500); assert.equal(f.clicks, 0); assert.match(f.control('status').episode, /第二集/); f.close();
});
test('排队后停止，取消切集', async () => {
  const f = await fixture(); f.control('start'); f.ended(); f.control('stop'); await f.advance(2500); assert.equal(f.clicks, 0); assert.equal(f.control('status').enabled, false); f.close();
});
test('全目录完成且无下个课程时停止', async () => {
  const f = await fixture({last: true, complete: true}); f.control('start'); f.ended(); await f.advance(11000); assert.equal(f.clicks, 0); assert.equal(f.control('status').phase, 'last'); assert.equal(f.control('status').enabled, false); f.close();
});
test('识别继续播放提示，确认并恢复', async () => {
  const f = await fixture(); let confirmed = 0; const d = f.dialog('请点击确定继续播放'); d.querySelector('button').onclick = () => {confirmed++; d.remove();};
  f.control('start'); await f.advance(1200); assert.equal(confirmed, 1); assert.equal(f.control('status').phase, 'playing'); f.close();
});
test('精确识别网站欢迎提示，只点击知道了，不改偏好复选框', async () => {
  const f = await fixture(); const d = f.dialog('');
  d.innerHTML = `<span>${welcomeText.slice(0, -3)}</span><input type="checkbox"><button>知道了</button>`;
  let count = 0; const checkbox = d.querySelector('input');
  d.querySelector('button').onclick = () => {count++; d.remove();};
  f.control('start'); await f.advance(1200);
  assert.equal(count, 1); assert.equal(checkbox.checked, false); assert.equal(f.control('status').phase, 'playing'); f.close();
});
test('欢迎提示加入答题控件时仍然等待人工', async () => {
  const f = await fixture(); const d = f.dialog('');
  d.innerHTML = `<span>${welcomeText.slice(0, -3)}</span><input type="checkbox"><input type="radio"><button>知道了</button>`;
  let count = 0; d.querySelector('button').onclick = () => count++;
  f.control('start'); await f.advance(1500); assert.equal(count, 0); assert.equal(f.control('status').phase, 'manual'); f.close();
});
test('同时出现欢迎提示和答题时不自动点击欢迎提示', async () => {
  const f = await fixture(); const d = f.dialog('');
  d.innerHTML = `<span>${welcomeText.slice(0, -3)}</span><input type="checkbox"><button>知道了</button>`;
  let count = 0; d.querySelector('button').onclick = () => count++; f.dialog('请回答单选题', true);
  f.control('start'); await f.advance(1500); assert.equal(count, 0); assert.equal(f.control('status').phase, 'manual'); f.close();
});
test('关闭自动确认时欢迎提示也需要人工处理', async () => {
  const f = await fixture(); const d = f.dialog('');
  d.innerHTML = `<span>${welcomeText.slice(0, -3)}</span><input type="checkbox"><button>知道了</button>`;
  let count = 0; d.querySelector('button').onclick = () => count++; f.control('option', {autoConfirm: false});
  f.control('start'); await f.advance(1500); assert.equal(count, 0); assert.equal(f.control('status').phase, 'manual'); f.close();
});
test('答题提示优先于继续播放，且不会自动作答', async () => {
  const f = await fixture(); let clicked = 0; const d = f.dialog('请回答单选题，确定后继续播放', true); d.querySelector('button').onclick = () => clicked++;
  f.control('start'); f.ended(); await f.advance(3000); assert.equal(clicked, 0); assert.equal(f.clicks, 0); assert.equal(f.control('status').phase, 'manual');
  d.remove(); await f.advance(300); assert.equal(f.control('status').phase, 'manual'); f.control('resume'); await f.advance(2300); assert.equal(f.clicks, 1); f.close();
});
test('同时出现答题与继续提示时不点击任何确认', async () => {
  const f = await fixture(); let clicked = 0; f.dialog('请点击确定继续播放').querySelector('button').onclick = () => clicked++;
  f.dialog('请回答问题'); f.control('start'); await f.advance(1500); assert.equal(clicked, 0); assert.equal(f.control('status').phase, 'manual'); f.close();
});
test('未知弹窗交给用户处理', async () => {
  const f = await fixture(); let clicked = 0; f.dialog('是否购买课程').querySelector('button').onclick = () => clicked++;
  f.control('start'); await f.advance(2000); assert.equal(clicked, 0); assert.equal(f.control('status').phase, 'manual'); f.close();
});
test('关闭自动确认后交给用户处理', async () => {
  const f = await fixture(); let clicked = 0; f.dialog('请点击确定继续播放').querySelector('button').onclick = () => clicked++;
  f.control('option', {autoConfirm: false}); f.control('start'); await f.advance(1500); assert.equal(clicked, 0); assert.equal(f.control('status').phase, 'manual'); f.close();
});
test('自动播放失败时提醒用户', async () => {
  const f = await fixture({rejectPlay: true}); f.control('start'); f.ended(); await f.advance(2500); assert.equal(f.clicks, 1); assert.equal(f.control('status').phase, 'manual'); assert.match(f.control('status').status, /自动播放未成功/); f.close();
});
test('当前集标记有歧义时停止', async () => {
  const f = await fixture(); f.w.document.querySelectorAll('[data-checked]')[1].dataset.checked = 'true'; f.control('start'); f.ended(); await f.advance(2500); assert.equal(f.clicks, 0); assert.equal(f.control('status').phase, 'error'); f.close();
});
test('同课程页面刷新恢复启用状态', async () => {
  const f = await fixture({enabled: true}); assert.equal(f.control('status').enabled, true); f.close();
});
test('跨课程后停止，不自动进入下一个课程', async () => {
  const f = await fixture(); f.control('start'); f.ended(); f.w.history.replaceState({}, '', '?project_id=p&course_id=another&resource_id=1'); f.w.document.body.append(f.w.document.createElement('span')); await f.advance(2500); assert.equal(f.clicks, 0); assert.equal(f.control('status').enabled, false); f.close();
});
test('播放器元素替换后重新绑定结束事件', async () => {
  const f = await fixture(); f.control('start'); f.replaceVideo(); await f.advance(300); f.ended(); await f.advance(2300); assert.equal(f.clicks, 1); f.close();
});
test('重复使用同一弹窗节点时能再次确认', async () => {
  const f = await fixture(); let count = 0; const d = f.dialog('请点击确定继续播放'); d.querySelector('button').onclick = () => {count++; d.hidden = true;};
  f.control('start'); await f.advance(1200); d.hidden = false; f.w.document.body.append(d); await f.advance(1500); assert.equal(count, 2); f.close();
});
test('目录全完成后只点击一次下个课程并自动播放新视频', async () => {
  const f = await fixture({last: true, complete: true, nextCourse: true}); f.control('start'); f.ended(); f.ended(); await f.advance(3000);
  assert.equal(f.courseClicks, 1); assert.equal(f.clicks, 0); assert.equal(f.control('status').enabled, true); assert.equal(f.control('status').phase, 'playing');
  const saved = f.messages.filter(msg => msg.type === 'assistant:save-session');
  assert(saved.some(msg => msg.state.pendingCourse?.clicked)); assert.equal(saved.at(-1).state.course, 'p:next'); assert.equal(saved.at(-1).state.pendingCourse, null); f.close();
});
test('最后一集结束但此前仍有未完成集数时自动补播，保持当前课程', async () => {
  const f = await fixture({last: true, nextCourse: true}); f.control('start'); f.ended(); await f.advance(3000);
  assert.equal(f.courseClicks, 0); assert.equal(f.clicks, 1); assert.equal(f.control('status').phase, 'playing'); assert.match(f.control('status').episode, /第一集/); f.close();
});
test('目录完成标记延迟到达时等待后再跳转', async () => {
  const f = await fixture({last: true, complete: true, nextCourse: true}); const info = [...f.w.document.querySelectorAll('[class*=rate-wrap_]')].at(-1); info.textContent = '99% 01 分 00 秒';
  f.control('start'); f.ended(); await f.advance(2000); assert.equal(f.courseClicks, 0);
  info.textContent = '完成'; await f.advance(1600); assert.equal(f.courseClicks, 1); assert.equal(f.control('status').phase, 'playing'); f.close();
});
test('即使补播的是第一集，目录全完成后也进入下一课程', async () => {
  const f = await fixture({complete: true, nextCourse: true}); f.control('start'); f.ended(); await f.advance(3000); assert.equal(f.courseClicks, 1); assert.equal(f.clicks, 0); f.close();
});
test('关闭跨课程选项后最后一集结束停止', async () => {
  const f = await fixture({last: true, complete: true, nextCourse: true}); f.control('course-option', {autoNextCourse: false}); f.control('start'); f.ended(); await f.advance(3000); assert.equal(f.courseClicks, 0); assert.equal(f.control('status').phase, 'last'); f.close();
});
test('禁用的下个课程入口不点击', async () => {
  const f = await fixture({last: true, complete: true, nextCourse: true, nextDisabled: true}); f.control('start'); f.ended(); await f.advance(3000); assert.equal(f.courseClicks, 0); assert.equal(f.control('status').enabled, false); f.close();
});
test('多个下个课程入口有歧义时人工处理', async () => {
  const f = await fixture({last: true, complete: true, nextCourse: true}); const second = f.w.document.querySelector('[class*=next-btn_]').cloneNode(true); f.w.document.body.append(second);
  f.control('start'); f.ended(); await f.advance(3000); assert.equal(f.courseClicks, 0); assert.equal(f.control('status').phase, 'manual'); f.close();
});
test('跨课程按钮无响应时最多重试三次并超时提醒', async () => {
  const f = await fixture({last: true, complete: true, nextCourse: true, navigate: false}); f.control('start'); f.ended(); await f.advance(64000);
  assert.equal(f.courseClicks, 3); assert.equal(f.control('status').phase, 'manual'); f.close();
});
test('跨课程保存失败时不点击', async () => {
  const f = await fixture({last: true, complete: true, nextCourse: true, saveFails: true}); f.control('start'); f.ended(); await f.advance(3000);
  assert.equal(f.courseClicks, 0); assert.equal(f.control('status').phase, 'manual'); f.close();
});
test('新课程还保留旧视频来源时等待加载', async () => {
  const f = await fixture({last: true, complete: true, nextCourse: true, navigate: false}); f.control('start'); f.ended(); await f.advance(2000);
  f.arrive({updateSource: false}); await f.advance(1500); assert.equal(f.video.media.playCount, 0); assert.equal(f.control('status').phase, 'course');
  f.video.setAttribute('src', 'blob:new-course'); await f.advance(1500); assert.equal(f.control('status').phase, 'playing'); assert.equal(f.courseClicks, 1); f.close();
});
test('跨课程等待中用户停止可取消恢复播放', async () => {
  const f = await fixture({last: true, complete: true, nextCourse: true, navigate: false}); f.control('start'); f.ended(); await f.advance(2000); f.control('stop'); f.arrive(); await f.advance(3000);
  assert.equal(f.video.media.playCount, 0); assert.equal(f.control('status').enabled, false); f.close();
});
test('完整页面跳转后从会话恢复跨课程播放', async () => {
  const f = await fixture({url: 'https://estudy.enaea.edu.cn/web/player/project?project_id=p&course_id=next&resource_id=new', stored: {course: 'p:c', enabled: true, autoConfirm: true, autoNextCourse: true, visitedCourses: ['p:c'], pendingCourse: {fromCourse: 'p:c', scope: 'p::', fromSource: 'blob:first', expiresAt: 30000, clicked: true, toCourse: null}}});
  await f.advance(1500); assert.equal(f.control('status').phase, 'playing'); assert.equal(f.control('status').enabled, true); assert.equal(f.courseClicks, 0); f.close();
});
test('过期的跨课程会话不会自动启用', async () => {
  const f = await fixture({url: 'https://estudy.enaea.edu.cn/web/player/project?project_id=p&course_id=next', stored: {course: 'p:c', enabled: true, pendingCourse: {fromCourse: 'p:c', scope: 'p::', expiresAt: -1}}});
  assert.equal(f.control('status').enabled, false); assert.equal(f.video.media.playCount, 0); f.close();
});
test('跨项目导航不自动恢复播放', async () => {
  const f = await fixture({last: true, complete: true, nextCourse: true, navigate: false}); f.control('start'); f.ended(); await f.advance(2000); f.arrive({scope: 'another'}); await f.advance(1500);
  assert.equal(f.control('status').phase, 'error'); assert.equal(f.video.media.playCount, 0); assert.equal(f.control('status').enabled, false); f.close();
});
test('课程循环时进入人工处理', async () => {
  const f = await fixture({last: true, complete: true, nextCourse: true, navigate: false}); f.control('start'); f.ended(); await f.advance(2000); f.arrive(); await f.advance(1500);
  const infos = [...f.w.document.querySelectorAll('[class*=rate-wrap_]')]; infos.forEach(info => info.textContent = '完成');
  f.ended(); await f.advance(2000); f.w.history.replaceState({}, '', '?project_id=p&course_id=c&resource_id=1'); f.video.setAttribute('src', 'blob:loop'); await f.advance(1500);
  assert.equal(f.control('status').phase, 'error'); assert.equal(f.courseClicks, 2); f.close();
});
test('100% 进度仍未显示完成时不跨课程', async () => {
  const f = await fixture({last: true, complete: true, nextCourse: true}); const info = [...f.w.document.querySelectorAll('[class*=rate-wrap_]')].at(-1); info.textContent = '100% 01 分 00 秒';
  f.control('start'); f.ended(); await f.advance(24000); assert.equal(f.courseClicks, 0); assert.equal(f.control('status').phase, 'playing'); assert.equal(f.clicks, 1); f.close();
});
test('跳入新课程后遇到答题保持人工等待', async () => {
  const f = await fixture({last: true, complete: true, nextCourse: true, navigate: false}); f.control('start'); f.ended(); await f.advance(2000);
  f.arrive(); f.dialog('请回答单选题', true); await f.advance(2000); assert.equal(f.control('status').phase, 'manual'); assert.equal(f.video.media.playCount, 0); f.close();
});
test('跨课程加载期间确认欢迎提示后继续核验并播放', async () => {
  const f = await fixture({last: true, complete: true, nextCourse: true, navigate: false});
  f.control('start'); f.ended(); await f.advance(2000); f.arrive();
  const d = f.dialog(''); d.innerHTML = `<span>${welcomeText.slice(0, -3)}</span><input type="checkbox"><button>知道了</button>`;
  let count = 0; d.querySelector('button').onclick = () => {count++; d.remove();};
  await f.advance(2500);
  assert.equal(count, 1); assert.equal(f.control('status').phase, 'playing');
  assert.equal(f.messages.filter(msg => msg.type === 'assistant:save-session').at(-1).state.pendingCourse, null); f.close();
});
test('跨课程跳转前排队时停止不会点击入口', async () => {
  const f = await fixture({last: true, complete: true, nextCourse: true}); f.control('start'); f.ended(); f.control('stop'); await f.advance(3000); assert.equal(f.courseClicks, 0); f.close();
});
test('新的跨课程状态存储包含选项和导航意图', async () => {
  const f = await fixture({last: true, complete: true, nextCourse: true, navigate: false}); f.control('start'); f.ended(); await f.advance(2000);
  const data = f.messages.filter(msg => msg.type === 'assistant:save-session').at(-1).state;
  assert.equal(data.autoNextCourse, true); assert.equal(data.pendingCourse.scope, 'p::'); assert.equal(data.pendingCourse.fromCourse, 'p:c'); assert.equal(data.pendingCourse.clicked, true); f.close();
});

test('同时读取播放条时间百分比与目录百分比，保留两者差异', async () => {
  const f = await fixture(); f.video.media.time = 54; f.video.media.duration = 60;
  f.w.document.querySelector('[class*=rate-wrap_]').textContent = '93%';
  const p = f.control('status').progress;
  assert.equal(p.currentTime, 54); assert.equal(p.duration, 60); assert.equal(p.playbackPercent, 90);
  assert.equal(p.directoryPercent, 93); assert.equal(p.directoryComplete, false);
  assert.match(f.control('status').progressText, /00:54 \/ 01:00（90.0%）/);
  assert.match(f.control('status').progressText, /目录当前集：93%/); f.close();
});
test('播放器时长未加载时显示待识别，不产生 NaN 或 Infinity', async () => {
  const f = await fixture(); f.video.media.duration = NaN;
  assert.equal(f.control('status').progress.duration, null);
  assert.equal(f.control('status').progress.playbackPercent, null);
  assert.doesNotMatch(f.control('status').progressText, /NaN|Infinity/); f.close();
});
test('播放条仅 93% 时目录全部完成，立即跨课程，不等待 ended', async () => {
  const f = await fixture({nextCourse: true}); f.video.media.time = 55.8; f.video.media.paused = false;
  f.control('start'); f.w.document.querySelectorAll('[class*=rate-wrap_]').forEach(p => p.textContent = '完成');
  await f.advance(2500); assert.equal(f.courseClicks, 1); assert.equal(f.control('status').phase, 'playing'); f.close();
});
test('已完成的当前集不重听，顺序跳过已完成的下一集', async () => {
  const f = await fixture(); const ps = f.w.document.querySelectorAll('[class*=rate-wrap_]');
  ps[0].textContent = '完成'; ps[1].textContent = '已完成'; ps[2].textContent = '91%';
  f.control('start'); await f.advance(2500);
  assert.equal(f.clicks, 1); assert.match(f.control('status').episode, /第三集/); assert.equal(f.video.media.playCount, 1); f.close();
});
test('末尾完成后自动补播最早的未完成集，跳过已完成集', async () => {
  const f = await fixture({last: true}); const ps = f.w.document.querySelectorAll('[class*=rate-wrap_]');
  ps[0].textContent = '完成'; ps[1].textContent = '94%'; ps[2].textContent = '完成';
  f.control('start'); await f.advance(2500);
  assert.equal(f.courseClicks, 0); assert.match(f.control('status').episode, /第二集/);
  assert(f.control('status').logs.some(line => line.includes('自动补播未完成集'))); f.close();
});
test('补播集达到完成标记后继续补播下一未完成集，全部完成再跨课程', async () => {
  const f = await fixture({last: true, nextCourse: true}); const ps = f.w.document.querySelectorAll('[class*=rate-wrap_]');
  ps[0].textContent = '91%'; ps[1].textContent = '92%'; ps[2].textContent = '完成';
  f.control('start'); await f.advance(2500); assert.match(f.control('status').episode, /第一集/);
  ps[0].textContent = '完成'; await f.advance(2500); assert.match(f.control('status').episode, /第二集/); assert.equal(f.courseClicks, 0);
  ps[1].textContent = '完成'; await f.advance(2500); assert.equal(f.courseClicks, 1); assert.equal(f.control('status').phase, 'playing'); f.close();
});
test('只剩当前集 93% 时结束后自动重选补播，重复播放能继续监听结束', async () => {
  const f = await fixture({last: true, complete: true, nextCourse: true});
  const p = [...f.w.document.querySelectorAll('[class*=rate-wrap_]')].at(-1); p.textContent = '93%';
  f.control('start'); f.ended(); await f.advance(25000); assert.equal(f.clicks, 1); assert.equal(f.courseClicks, 0); assert.equal(f.control('status').phase, 'playing');
  p.textContent = '94%'; f.ended(); await f.advance(25000); assert.equal(f.clicks, 2); assert.equal(f.control('status').phase, 'playing'); f.close();
});
test('补播连续无进展时有界停止，不无限重听', async () => {
  const f = await fixture({last: true, complete: true});
  [...f.w.document.querySelectorAll('[class*=rate-wrap_]')].at(-1).textContent = '93%';
  f.control('start'); for (let i = 0; i < 4; i++) {f.ended(); await f.advance(25000);}
  assert.equal(f.clicks, 3); assert.equal(f.control('status').phase, 'manual'); assert.match(f.control('status').status, /连续未更新/); f.close();
});
test('目录百分比提高到 99% 但没有完成标记时继续播放当前集', async () => {
  const f = await fixture({nextCourse: true}); f.control('start');
  f.w.document.querySelector('[class*=rate-wrap_]').textContent = '99%'; await f.advance(2500);
  assert.equal(f.clicks, 0); assert.equal(f.courseClicks, 0); assert.equal(f.control('status').progress.directoryComplete, false); f.close();
});
test('目录文本节点更新为完成时无需 DOM 重建即可跳转', async () => {
  const f = await fixture({nextCourse: true}); f.control('start');
  f.w.document.querySelectorAll('[class*=rate-wrap_]').forEach(p => p.firstChild.data = '完成');
  await f.advance(2500); assert.equal(f.courseClicks, 1); f.close();
});
test('全部完成时检测到答题仍优先人工处理', async () => {
  const f = await fixture({complete: true, nextCourse: true}); f.dialog('请回答单选题', true);
  f.control('start'); await f.advance(3000); assert.equal(f.courseClicks, 0); assert.equal(f.control('status').phase, 'manual'); f.close();
});
test('全部完成即时跳转排队期间停止可取消', async () => {
  const f = await fixture({complete: true, nextCourse: true}); f.control('start'); f.control('stop');
  await f.advance(3000); assert.equal(f.courseClicks, 0); assert.equal(f.control('status').enabled, false); f.close();
});
test('网站自行切入已完成集后，助手选择下一未完成集', async () => {
  const f = await fixture(); f.control('start'); f.ended(); f.select(1);
  f.w.document.querySelectorAll('[class*=rate-wrap_]')[1].textContent = '完成';
  await f.advance(2500); assert.equal(f.clicks, 1); assert.match(f.control('status').episode, /第三集/); f.close();
});
test('关闭跨课程开关仍自动补播，全部完成后停止当前课程', async () => {
  const f = await fixture({last: true, nextCourse: true}); const ps = f.w.document.querySelectorAll('[class*=rate-wrap_]');
  ps[0].textContent = '完成'; ps[2].textContent = '完成';
  f.control('course-option', {autoNextCourse: false}); f.control('start'); await f.advance(2500);
  assert.match(f.control('status').episode, /第二集/); ps[1].textContent = '完成'; await f.advance(2500);
  assert.equal(f.courseClicks, 0); assert.equal(f.control('status').enabled, false); assert.equal(f.control('status').phase, 'last'); f.close();
});

function player(f) {return f.video.closest('.xgplayer');}
function central(f) {const element = f.w.document.createElement('xg-start'); element.className='xgplayer-start'; player(f).append(element); return element;}
function play(f) {f.video.media.paused=false; f.video.dispatchEvent(new f.w.Event('playing'));}
function pause(f) {f.video.media.paused=true; f.video.dispatchEvent(new f.w.Event('pause'));}
function playbackMessages(f) {return f.messages.filter(m => m.type === 'assistant:playback');}
test('实际播放时隐藏中央播放按钮，暂停恢复，恢复播放再隐藏', async () => {
  const f=await fixture(); const button=central(f); play(f); await f.advance(300);
  assert.equal(f.w.getComputedStyle(button).display,'none'); assert.equal(f.video.media.playCount,0);
  pause(f); assert.notEqual(f.w.getComputedStyle(button).display,'none');
  play(f); assert.equal(f.w.getComputedStyle(button).display,'none'); f.close();
});
test('结束和换源加载时恢复中央按钮；新视频播放后隐藏', async () => {
  const f=await fixture(); const button=central(f); play(f); f.ended(); assert.notEqual(f.w.getComputedStyle(button).display,'none');
  f.select(1); f.video.media.ready=0; f.video.dispatchEvent(new f.w.Event('emptied')); assert.notEqual(f.w.getComputedStyle(button).display,'none');
  f.video.media.ready=4; play(f); assert.equal(f.w.getComputedStyle(button).display,'none');
  f.replaceVideo(); await f.advance(300); assert.notEqual(f.w.getComputedStyle(button).display,'none');
  play(f); assert.equal(f.w.getComputedStyle(button).display,'none'); f.close();
});
test('修复只作用于中央启动按钮，工具栏和答题仍可见', async () => {
  const f=await fixture(); const button=central(f); const toolbar=f.w.document.createElement('xg-play'); player(f).append(toolbar);
  const quiz=f.dialog('请回答单选题',true); f.control('start'); play(f); await f.advance(300);
  assert.equal(f.w.getComputedStyle(button).display,'none'); assert.notEqual(f.w.getComputedStyle(toolbar).display,'none'); assert.notEqual(f.w.getComputedStyle(quiz).display,'none');
  assert.equal(f.control('status').phase,'manual'); assert.equal(f.control('status').wakeActive,false); f.close();
});
test('启用助手且实际播放才请求唤醒；暂停、恢复、停止同步释放', async () => {
  const f=await fixture(); play(f); await f.advance(1); assert.equal(playbackMessages(f).at(-1).playing,false);
  f.control('start'); await f.advance(1); assert.equal(f.control('status').wakeActive,true);
  pause(f); await f.advance(1); assert.equal(playbackMessages(f).at(-1).playing,false); assert.equal(f.control('status').wakeActive,false);
  play(f); await f.advance(1); assert.equal(playbackMessages(f).at(-1).playing,true);
  f.control('stop'); await f.advance(1); assert.equal(playbackMessages(f).at(-1).playing,false); f.close();
});
test('唤醒开关持久保存；页面离开释放，返回后恢复', async () => {
  const f=await fixture(); play(f); f.control('start'); await f.advance(1);
  f.control('awake-option',{keepAwake:false}); await f.advance(1); assert.equal(f.control('status').keepAwake,false); assert.equal(playbackMessages(f).at(-1).playing,false);
  assert.equal(f.messages.filter(m=>m.type==='assistant:save-session').at(-1).state.keepAwake,false);
  f.control('awake-option',{keepAwake:true}); await f.advance(1);
  f.w.dispatchEvent(new f.w.Event('pagehide')); await f.advance(1); assert.equal(playbackMessages(f).at(-1).playing,false);
  f.w.dispatchEvent(new f.w.Event('pageshow')); await f.advance(1); assert.equal(playbackMessages(f).at(-1).playing,true); f.close();
});
test('唤醒心跳限频，结束或错误立即释放', async () => {
  const f=await fixture(); play(f); f.control('start'); await f.advance(1); const count=playbackMessages(f).length;
  f.video.dispatchEvent(new f.w.Event('timeupdate')); await f.advance(14000); assert.equal(playbackMessages(f).length,count);
  await f.advance(1000); f.video.dispatchEvent(new f.w.Event('timeupdate')); await f.advance(1); assert.equal(playbackMessages(f).length,count+1);
  f.video.dispatchEvent(new f.w.Event('error')); await f.advance(1); assert.equal(playbackMessages(f).at(-1).playing,false);
  assert.equal(f.control('status').phase,'manual'); f.close();
});
test('暂停的初始视频和已关闭唤醒偏好不会请求保持唤醒', async () => {
  const f=await fixture({stored:{course:'p:c',enabled:true,keepAwake:false}}); play(f); await f.advance(1);
  assert.equal(playbackMessages(f).some(m=>m.playing),false); assert.equal(f.control('status').keepAwake,false); f.close();
});
test('电源请求未成功时不显示已保持唤醒', async () => {
  const f=await fixture({saveFails:true}); play(f); f.control('start'); await f.advance(1);
  assert.equal(f.control('status').wakeActive,false); assert.match(f.control('status').awakeText,/未能开启/); f.close();
});

test('收起后仍显示实时播放与目录进度、状态，并保存收起偏好', async () => {
  const f=await fixture(); f.control('start'); play(f); await f.advance(1);
  const shadow=f.w.document.getElementById('course-assistant-host').shadowRoot;
  shadow.getElementById('collapse').click(); await f.advance(1);
  assert.equal(shadow.getElementById('body').hidden,true);
  assert.equal(shadow.querySelector('.overview').hidden,false);
  f.video.media.time=30; f.video.dispatchEvent(new f.w.Event('timeupdate'));
  assert.equal(shadow.getElementById('percentage').textContent,'50.0%');
  assert.match(shadow.getElementById('status').textContent,/连续播放中/);
  assert.match(shadow.getElementById('awake').textContent,/保护/);
  assert.equal(f.messages.filter(m=>m.type==='assistant:save-session').at(-1).state.collapsed,true);
  shadow.getElementById('collapse').click(); assert.equal(shadow.getElementById('body').hidden,false); f.close();
});
test('目录先选中但旧媒体仍在时不提前播放，真实加载后继续', async () => {
  const f=await fixture(); const listing=[...f.w.document.querySelectorAll('[data-checked]')];
  let clicks=0;
  listing[1].addEventListener('click', e=>{e.stopImmediatePropagation();clicks++; listing.forEach((r,i)=>r.dataset.checked=String(i===1)); f.w.history.replaceState({},'','?project_id=p&course_id=c&resource_id=2');},true);
  f.control('start'); f.ended(); await f.advance(3000);
  assert.equal(f.video.media.playCount,0); assert.equal(f.control('status').phase,'switching');
  f.select(1); await f.advance(700); assert.equal(f.control('status').phase,'playing'); assert.equal(clicks,1); f.close();
});
test('首次切集点击丢失后重试相同目标，成功后不多跳一集', async () => {
  const f=await fixture(); const target=f.w.document.querySelectorAll('[data-checked]')[1]; let attempts=0;
  target.addEventListener('click',e=>{if(++attempts===1)e.stopImmediatePropagation();},true);
  f.control('start'); f.ended(); await f.advance(11500);
  assert.equal(attempts,2); assert.match(f.control('status').episode,/第二集/); assert.equal(f.control('status').phase,'playing'); f.close();
});
test('目标已开始慢加载时不再次点击，等待超过旧版20秒也能成功', async () => {
  const f=await fixture(); const target=f.w.document.querySelectorAll('[data-checked]')[1]; let attempts=0;
  target.addEventListener('click',e=>{e.stopImmediatePropagation();attempts++; f.video.media.ready=0; f.video.dispatchEvent(new f.w.Event('loadstart')); f.w.setTimeout(()=>{f.select(1);f.video.media.ready=4;f.video.dispatchEvent(new f.w.Event('loadedmetadata'));},26000);},true);
  f.control('start'); f.ended(); await f.advance(24000); assert.equal(attempts,1); assert.equal(f.video.media.playCount,0);
  await f.advance(5000); assert.equal(f.control('status').phase,'playing'); assert.equal(attempts,1); f.close();
});
test('切集目标DOM重建后依标题定位重试', async () => {
  const f=await fixture(); const target=f.w.document.querySelectorAll('[data-checked]')[1]; let attempts=0;
  target.addEventListener('click',e=>{e.stopImmediatePropagation(); attempts++; if(attempts===1){const clone=target.cloneNode(true); clone.addEventListener('click',()=>{attempts++;f.select(1);clone.dataset.checked='true';});target.replaceWith(clone);}},true);
  f.control('start'); f.ended(); await f.advance(12000); assert.equal(attempts,2); assert.equal(f.control('status').phase,'playing'); f.close();
});
test('首次跨课程点击无响应时重试，观察到导航后停止重试', async () => {
  const f=await fixture({complete:true,nextCourse:true,navigate:false}); let attempts=0;
  f.w.document.querySelector('[class*=next-btn_]').addEventListener('click',()=>{if(++attempts===2)f.arrive();});
  f.control('start'); await f.advance(12000); assert.equal(attempts,2); assert.equal(f.control('status').phase,'playing'); f.close();
});
test('新视频先到、目录仍是旧课程时等待目录刷新', async () => {
  const f=await fixture({complete:true,nextCourse:true,navigate:false}); f.control('start'); await f.advance(2000);
  f.w.history.replaceState({},'','?project_id=p&course_id=next&resource_id=new');f.video.setAttribute('src','blob:new-course');
  await f.advance(1500); assert.equal(f.video.media.playCount,0); assert.equal(f.control('status').phase,'course');
  f.arrive(); await f.advance(1500); assert.equal(f.control('status').phase,'playing'); f.close();
});
test('完整页面切集后恢复指定目标并开始播放', async () => {
  const f=await fixture({stored:{course:'p:c',enabled:true,pendingEpisode:{fromCourse:'p:c',scope:'p::',fromSource:'blob:old',fromTitle:'其他集',nextTitle:'第一集 标题',expiresAt:45000,attempts:1,lastClickAt:0}},url:'https://estudy.enaea.edu.cn/web/player/project?project_id=p&course_id=c&resource_id=1'});
  await f.advance(1200); assert.equal(f.control('status').phase,'playing'); assert.equal(f.messages.filter(m=>m.type==='assistant:save-session').at(-1).state.pendingEpisode,null); f.close();
});
test('短暂缓冲和自动切集期间持续请求唤醒，显式暂停仍释放', async () => {
  const f=await fixture(); f.control('start');play(f);await f.advance(1);
  f.video.media.ready=1;f.video.dispatchEvent(new f.w.Event('waiting'));await f.advance(1);assert.equal(f.control('status').wakeActive,true);
  f.video.media.ready=4;f.ended();await f.advance(1);assert.equal(playbackMessages(f).at(-1).playing,true);
  await f.advance(2600);pause(f);await f.advance(1);assert.equal(playbackMessages(f).at(-1).playing,false);f.close();
});
test('切集等待遇到人工题目时停止重试和唤醒', async () => {
  const f=await fixture(); const target=f.w.document.querySelectorAll('[data-checked]')[1]; let attempts=0;
  target.addEventListener('click',e=>{e.stopImmediatePropagation();attempts++;},true); f.control('start'); f.ended(); await f.advance(2000);
  f.dialog('请回答单选题',true); await f.advance(12000); assert.equal(attempts,1); assert.equal(f.control('status').phase,'manual'); assert.equal(playbackMessages(f).at(-1).playing,false); f.close();
});

test('文件名和普通标题目录按页面结构识别，排除其他 item-wrap 节点', async () => {
  const f=await fixture();const list=[...f.w.document.querySelectorAll('[data-checked]')];
  list.forEach((row,i)=>row.querySelector('[class*=name-span_]').textContent=`网络安全屏障0${i+1}.mp4`);
  const unrelated=f.w.document.createElement('div');unrelated.className='item-wrap_OTHER';unrelated.textContent='简介';f.w.document.body.append(unrelated);
  assert.equal(f.control('status').episodeCount,3);
  f.control('start');f.ended();await f.advance(2500);assert.equal(f.clicks,1);assert.equal(f.control('status').phase,'playing');assert.match(f.control('status').episode,/02.mp4/);f.close();
});
test('新课程文件名目录加载后自动恢复播放', async () => {
  const f=await fixture({complete:true,nextCourse:true,navigate:false});f.control('start');await f.advance(2000);f.arrive();
  [...f.w.document.querySelectorAll('[data-checked]')].forEach((r,i)=>r.querySelector('[class*=name-span_]').textContent=`课程视频0${i+1}.mp4`);
  await f.advance(1500);assert.equal(f.control('status').phase,'playing');assert.equal(f.video.media.playCount,1);assert.equal(f.courseClicks,1);f.close();
});
test('欢迎提示延迟关闭超过900毫秒仍自动恢复，不要求手动处理', async () => {
  const f=await fixture();const d=f.dialog('');d.innerHTML=`<span>${welcomeText.slice(0,-3)}</span><input type="checkbox"><button>知道了</button>`;
  let clicks=0;d.querySelector('button').onclick=()=>{clicks++;f.w.setTimeout(()=>d.remove(),1600);};
  f.control('start');await f.advance(1200);assert.notEqual(f.control('status').phase,'manual');await f.advance(1000);
  assert.equal(clicks,1);assert.equal(f.control('status').phase,'playing');f.close();
});
test('欢迎提示第一次点击无效时有限重试并自动恢复', async () => {
  const f=await fixture();const d=f.dialog('');d.innerHTML=`<span>${welcomeText.slice(0,-3)}</span><input type="checkbox"><button>知道了</button>`;
  let clicks=0;d.querySelector('button').onclick=()=>{if(++clicks===2)d.hidden=true;};f.control('start');await f.advance(3000);
  assert.equal(clicks,2);assert.equal(f.control('status').phase,'playing');f.close();
});
test('透明的残留弹窗不阻断播放，祖先aria-hidden时也忽略', async () => {
  for(const kind of ['opacity','ancestor']){
    const f=await fixture();const d=f.dialog('请点击确定继续播放');
    d.querySelector('button').onclick=()=>{if(kind==='opacity')d.style.opacity='0';else{const parent=f.w.document.createElement('div');parent.setAttribute('aria-hidden','true');d.replaceWith(parent);parent.append(d);}};
    f.control('start');await f.advance(1300);assert.equal(f.control('status').phase,'playing');f.close();
  }
});
test('确认节点转为答题时停止自动点击并提示手动处理', async () => {
  const f=await fixture();const d=f.dialog('请点击确定继续播放');let clicks=0;
  d.querySelector('button').onclick=()=>{clicks++;d.querySelector('p').textContent='请回答问题';d.append(f.w.document.createElement('input'));};
  f.control('start');await f.advance(2500);assert.equal(clicks,1);assert.equal(f.control('status').phase,'manual');f.close();
});
test('永久未响应的确认最多点击三次，停止后取消后续确认', async () => {
  const f=await fixture();const d=f.dialog('请点击确定继续播放');let clicks=0;d.querySelector('button').onclick=()=>clicks++;
  f.control('start');await f.advance(9000);assert.equal(clicks,3);assert.equal(f.control('status').phase,'manual');f.close();
  const g=await fixture();const e=g.dialog('请点击确定继续播放');let n=0;e.querySelector('button').onclick=()=>n++;
  g.control('start');g.control('stop');await g.advance(9000);assert.equal(n,1);assert.equal(g.video.media.playCount,0);g.close();
});
test('跨课程欢迎提示延迟关闭，随后识别文件名目录并播放', async () => {
  const f=await fixture({complete:true,nextCourse:true,navigate:false});f.control('start');await f.advance(2000);f.arrive();
  [...f.w.document.querySelectorAll('[data-checked]')].forEach((r,i)=>r.querySelector('[class*=name-span_]').textContent=`下一课程0${i+1}.mp4`);
  const d=f.dialog('');d.innerHTML=`<span>${welcomeText.slice(0,-3)}</span><input type="checkbox"><button>知道了</button>`;
  d.querySelector('button').onclick=()=>f.w.setTimeout(()=>d.remove(),1700);
  await f.advance(4000);assert.equal(f.control('status').phase,'playing');assert.equal(f.courseClicks,1);assert.equal(f.video.media.playCount,1);f.close();
});

test('红绿灯以真实播放和选项状态计算，并在收起时保留', async () => {
  const f=await fixture();let data=f.control('status');assert.equal(data.traffic.color,'red');
  f.control('start');f.video.media.paused=false;f.video.dispatchEvent(new f.w.Event('playing'));
  const base={...f.control('status'),wakeActive:true,nativeActive:true};
  assert.equal(f.w.CourseAssistantCore.trafficState(base).color,'green');
  assert.equal(f.w.CourseAssistantCore.trafficState({...base,autoConfirm:false}).color,'yellow');
  assert.equal(f.w.CourseAssistantCore.trafficState({...base,autoNextCourse:false}).color,'yellow');
  assert.equal(f.w.CourseAssistantCore.trafficState({...base,keepAwake:false}).color,'yellow');
  assert.equal(f.w.CourseAssistantCore.trafficState({...base,mediaPlaying:false}).color,'red');
  const root=f.w.document.getElementById('course-assistant-host').shadowRoot;
  f.w.CourseAssistantUI.render(f.w.CourseAssistantUI.bind(root),{...base,traffic:{color:'green',text:'全部正常运行'}});
  assert.equal(root.getElementById('traffic-label'),null);
  assert.equal(root.getElementById('traffic').parentElement,root.getElementById('collapse').parentElement);
  assert.match(root.getElementById('traffic').getAttribute('aria-label'),/绿灯/);
  root.getElementById('collapse').click();assert.equal(root.getElementById('body').hidden,true);assert.equal(root.getElementById('traffic').hidden,false);f.close();
});
function savedNetwork(f){return f.messages.filter(x=>x.type==='assistant:save-session').at(-1).state;}
test('网络错误等待2分钟才重试，刷新前保存次数和固定时间窗口', async () => {
  const f=await fixture();f.control('start');f.video.media.error={code:2};f.video.dispatchEvent(new f.w.Event('error'));
  assert.equal(f.control('status').phase,'network');assert.equal(f.control('status').traffic.color,'red');
  await f.advance(119999);assert.equal(f.messages.filter(x=>x.type==='test:reload').length,0);
  await f.advance(1);assert.equal(f.messages.filter(x=>x.type==='test:reload').length,1);
  const state=savedNetwork(f);assert.equal(state.networkJob.attempts,1);assert.equal(state.networkJob.startedAt,0);assert.equal(state.networkJob.inFlight,true);f.close();
});
test('跨刷新实际播放时间前进后取消全部剩余重试', async () => {
  const stored={course:'p:c',enabled:true,autoConfirm:true,networkJob:{id:'job',course:'p:c',scope:'p::',resource:'1',startedAt:0,attempts:1,nextAttemptAt:120000,inFlight:true,checkUntil:150000}};
  const f=await fixture({stored,initialTime:120000});assert.equal(f.control('status').phase,'network');
  await f.advance(1000);f.video.media.time=11;f.video.dispatchEvent(new f.w.Event('timeupdate'));await f.advance(1000);
  assert.equal(f.control('status').phase,'playing');assert.equal(savedNetwork(f).networkJob,null);
  await f.advance(700000);assert.equal(f.messages.filter(x=>x.type==='test:reload').length,0);f.close();
});
test('播放事件但时间未前进不误判网络恢复', async () => {
  const stored={course:'p:c',enabled:true,autoConfirm:true,networkJob:{id:'job',course:'p:c',scope:'p::',resource:'1',startedAt:0,attempts:1,nextAttemptAt:120000,inFlight:true,checkUntil:150000}};
  const f=await fixture({stored,initialTime:120000});f.video.media.paused=false;f.video.dispatchEvent(new f.w.Event('playing'));
  await f.advance(31000);assert.equal(f.control('status').phase,'network');assert.equal(savedNetwork(f).networkJob.nextAttemptAt,240000);f.close();
});
test('网络持续失败在2、4、6分钟各尝试一次，第三次核验结束后停止释放保护', async () => {
  let f=await fixture({networkErrorCode:2});f.control('start');await f.advance(120000);
  let stored=savedNetwork(f);assert.equal(stored.networkJob.attempts,1);f.close();
  f=await fixture({stored,initialTime:120000,networkErrorCode:2});await f.advance(120000);
  stored=savedNetwork(f);assert.equal(stored.networkJob.attempts,2);assert.equal(stored.networkJob.checkUntil,270000);f.close();
  f=await fixture({stored,initialTime:240000,networkErrorCode:2});await f.advance(120000);
  stored=savedNetwork(f);assert.equal(stored.networkJob.attempts,3);assert.equal(stored.networkJob.checkUntil,390000);f.close();
  f=await fixture({stored,initialTime:360000,networkErrorCode:2});await f.advance(30000);
  assert.equal(f.control('status').enabled,false);assert.equal(f.control('status').phase,'error');
  assert.equal(f.messages.filter(x=>x.type==='assistant:network-exhausted').length,1);
  assert.ok(f.messages.some(x=>x.type==='assistant:attention' && x.reason.includes('网络重试 3 次仍未恢复')));
  assert.equal(f.messages.filter(x=>x.type==='assistant:playback').at(-1).playing,false);assert.equal(f.messages.filter(x=>x.type==='test:reload').length,0);f.close();
});
test('网络等待时停止或答题取消原网络计划，不产生网络终止请求', async () => {
  const f=await fixture({networkErrorCode:2});f.control('start');f.control('stop');await f.advance(1000000);
  assert.equal(f.messages.filter(x=>x.type==='test:reload'||x.type==='assistant:network-exhausted').length,0);f.close();
  const g=await fixture({networkErrorCode:2});g.control('start');g.dialog('请回答问题');await g.advance(1000000);
  assert.equal(g.control('status').phase,'manual');assert.equal(g.messages.filter(x=>x.type==='assistant:network-exhausted').length,0);assert.equal(g.messages.filter(x=>x.type==='test:reload').length,1);g.close();
});
test('非网络解码错误使用一次普通恢复，不启动三次网络计划', async () => {
  const f=await fixture({networkErrorCode:3});f.control('start');assert.notEqual(f.control('status').phase,'network');f.video.dispatchEvent(new f.w.Event('error'));await f.advance(1000000);
  assert.equal(f.control('status').phase,'manual');assert.equal(f.messages.filter(x=>x.type==='test:reload').length,1);f.close();
});
test('恢复计划目标课程变化后取消，不刷新用户新选的课程', async () => {
  const f=await fixture({networkErrorCode:2});f.control('start');f.w.history.replaceState({},'', '?project_id=p&course_id=other&resource_id=1');await f.advance(120000);
  assert.equal(f.control('status').enabled,false);assert.equal(f.messages.filter(x=>x.type==='test:reload').length,0);f.close();
});

test('网站自行恢复播放时无需等到2分钟就取消计划',async()=>{
  const f=await fixture({networkErrorCode:2});f.control('start');await f.advance(5000);
  f.video.media.error=null;f.video.media.paused=false;f.video.dispatchEvent(new f.w.Event('playing'));
  f.video.media.time=11;f.video.dispatchEvent(new f.w.Event('timeupdate'));await f.advance(1000);
  assert.equal(f.control('status').phase,'playing');assert.equal(savedNetwork(f).networkJob,null);await f.advance(360000);assert.equal(f.messages.filter(x=>x.type==='test:reload').length,0);f.close();
});

function singleDirectory(f, name='全一集', checked=true) {
  const list=[...f.w.document.querySelectorAll('[class*=item-wrap_]')];
  list.slice(1).forEach(row=>row.remove());
  list[0].querySelector('[class*=name-span_]').textContent=name;
  if (!checked) list[0].removeAttribute('data-checked');
  return list[0];
}
test('相邻两课程都叫全一集时完成后跳转并播放，不因同名超时', async () => {
  const f=await fixture({complete:true,nextCourse:true});singleDirectory(f);
  f.w.document.querySelector('[class*=next-btn_]').addEventListener('click',()=>singleDirectory(f));
  f.control('start');await f.advance(3000);
  assert.equal(f.courseClicks,1);assert.equal(f.video.media.playCount,1);
  assert.equal(f.control('status').phase,'playing');assert.equal(f.control('status').episode,'全一集');
  await f.advance(62000);assert.equal(f.courseClicks,1);assert.notEqual(f.control('status').phase,'manual');f.close();
});
test('相邻课程目录标题完全相同但进度重置，仍核验并播放', async () => {
  const f=await fixture({complete:true,nextCourse:true});
  const titles=[...f.w.document.querySelectorAll('[class*=name-span_]')].map(e=>e.textContent);
  f.w.document.querySelector('[class*=next-btn_]').addEventListener('click',()=>{
    [...f.w.document.querySelectorAll('[class*=name-span_]')].forEach((e,i)=>e.textContent=titles[i]);
  });
  f.control('start');await f.advance(3000);assert.equal(f.courseClicks,1);assert.equal(f.control('status').phase,'playing');assert.equal(f.video.media.playCount,1);f.close();
});
test('无选中标记的单视频目录按完成状态跳转并播放下一课程', async () => {
  const f=await fixture({complete:true,nextCourse:true});singleDirectory(f,'学习视频.mp4',false);
  f.w.document.querySelector('[class*=next-btn_]').addEventListener('click',()=>singleDirectory(f,'学习视频.mp4',false));
  assert.equal(f.control('status').episodeCount,1);assert.equal(f.control('status').progress.directoryComplete,true);
  f.control('start');await f.advance(3000);assert.equal(f.courseClicks,1);assert.equal(f.video.media.playCount,1);assert.equal(f.control('status').phase,'playing');f.close();
});
test('全一集仍有99%但未完成时不会跳过，完成标记到达后跨课程', async () => {
  const f=await fixture({nextCourse:true});const row=singleDirectory(f);const rate=row.querySelector('[class*=rate-wrap_]');rate.textContent='99%';
  f.control('start');f.ended();await f.advance(2500);assert.equal(f.courseClicks,0);
  rate.textContent='完成';await f.advance(1800);assert.equal(f.courseClicks,1);assert.equal(f.control('status').phase,'playing');f.close();
});
test('同名全一集的新源到达但旧完成目录残留时不误跳下一课程', async () => {
  const f=await fixture({complete:true,nextCourse:true,navigate:false});const row=singleDirectory(f);
  f.control('start');await f.advance(2000);
  f.w.history.replaceState({},'','?project_id=p&course_id=next&resource_id=new');
  f.video.setAttribute('src','blob:new-course');f.video.media.ended=false;f.video.dispatchEvent(new f.w.Event('loadedmetadata'));
  await f.advance(2500);assert.equal(f.video.media.playCount,0);assert.equal(f.courseClicks,1);assert.equal(f.control('status').phase,'course');
  row.querySelector('[class*=rate-wrap_]').textContent='0%';await f.advance(1200);
  assert.equal(f.video.media.playCount,1);assert.equal(f.courseClicks,1);assert.equal(f.control('status').phase,'playing');f.close();
});
test('同名同完成进度的新目录节点重建后可继续核验', async () => {
  const f=await fixture({complete:true,nextCourse:true,navigate:false});singleDirectory(f);f.control('start');await f.advance(2000);
  f.w.history.replaceState({},'','?project_id=p&course_id=next&resource_id=new');f.video.setAttribute('src','blob:new-course');f.video.media.ended=false;
  const old=f.w.document.querySelector('[class*=item-wrap_]');old.replaceWith(old.cloneNode(true));
  f.w.document.querySelector('[class*=next-btn_]').remove();await f.advance(12000);
  assert.equal(f.courseClicks,1);assert.equal(f.control('status').phase,'last');
  assert(f.control('status').logs.some(line=>line.includes('已核验新课程目录和视频加载')));f.close();
});
test('全一集完整页面跳转恢复会话，即使标题同名也开始播放', async () => {
  const f=await fixture({url:'https://estudy.enaea.edu.cn/web/player/project?project_id=p&course_id=next&resource_id=new',stored:{course:'p:c',enabled:true,autoNextCourse:true,pendingCourse:{fromCourse:'p:c',scope:'p::',fromSource:'blob:old',fromDirectory:'全一集',fromDirectoryState:'[{"complete":true,"percent":100,"checked":true}]',expiresAt:30000},visitedCourses:['p:c']}});
  singleDirectory(f);await f.advance(1500);assert.equal(f.control('status').phase,'playing');assert.equal(f.video.media.playCount,1);f.close();
});

test('人工问题119秒不刷新，满2分钟只刷新一次且再次失败通知',async()=>{
  const f=await fixture();f.dialog('未知错误，请人工检查');f.control('start');
  assert.match(f.control('status').retryText,/自动刷新一次/);await f.advance(119999);assert.equal(f.messages.filter(x=>x.type==='test:reload').length,0);
  await f.advance(1);assert.equal(f.messages.filter(x=>x.type==='test:reload').length,1);
  await f.advance(60000);assert.equal(f.control('status').phase,'manual');
  assert(f.messages.some(x=>x.type==='assistant:attention'&&x.reason.includes('自动刷新后')));
  await f.advance(240000);assert.equal(f.messages.filter(x=>x.type==='test:reload').length,1);f.close();
});
test('真实用户操作取消等待，脚本点击不会误当作反馈',async()=>{
  const f=await fixture();const d=f.dialog('未知错误');f.control('start');d.querySelector('button').click();await f.advance(1000);
  assert.equal(f.manualStore.stage,'waiting');f.feedback();await f.advance(180000);
  assert.equal(f.messages.filter(x=>x.type==='test:reload').length,0);assert.equal(f.manualStore.feedback,true);f.close();
});
test('答题或验证码无反馈也只刷新一次，不自动选择或提交答案',async()=>{
  const f=await fixture();const d=f.dialog('验证码：请选择答案',true);let answered=0;d.querySelector('button').onclick=()=>answered++;
  f.control('start');await f.advance(120000);assert.equal(f.messages.filter(x=>x.type==='test:reload').length,1);assert.equal(answered,0);await f.advance(180000);assert.equal(f.control('status').phase,'manual');assert.equal(answered,0);f.close();
});
test('答题过程中收到输入反馈则不刷新',async()=>{
  const f=await fixture();f.dialog('请回答单选题',true);f.control('start');await f.advance(90000);f.feedback();await f.advance(180000);assert.equal(f.messages.filter(x=>x.type==='test:reload').length,0);f.close();
});
test('恢复前停止助手或选择其他资源取消一次刷新计划',async()=>{
  for(const action of ['stop','navigate']){
    const f=await fixture();f.dialog('未知问题');f.control('start');
    if(action==='stop')f.control('stop');else f.w.history.replaceState({},'','?project_id=p&course_id=c&resource_id=other');
    await f.advance(180000);assert.equal(f.messages.filter(x=>x.type==='test:reload').length,0);f.close();
  }
});
test('完整刷新恢复已尝试标记，确认播放时间前进后取消提醒',async()=>{
  const f=await fixture({stored:{course:'p:c',enabled:true,manualRecovery:{id:'r',course:'p:c',scope:'p::',resource:'1',reason:'播放失败',stage:'checking',attempted:true,feedback:false,dueAt:120000,checkUntil:180000}},initialTime:120000});
  await f.advance(1000);assert.equal(f.video.media.playCount,1);assert.notEqual(f.control('status').phase,'manual');
  f.video.media.time=11;f.video.dispatchEvent(new f.w.Event('timeupdate'));await f.advance(1);
  assert.equal(f.manualStore,null);assert.equal(f.control('status').phase,'playing');assert(f.messages.some(x=>x.type==='assistant:clear-attention'));f.close();
});
test('刷新后只有playing事件而无时间前进仍在一分钟后要求手动',async()=>{
  const f=await fixture({stored:{course:'p:c',enabled:true,manualRecovery:{id:'r',course:'p:c',scope:'p::',resource:'1',reason:'播放失败',stage:'checking',attempted:true,feedback:false,dueAt:120000,checkUntil:180000}},initialTime:120000});
  await f.advance(60000);assert.equal(f.control('status').phase,'manual');assert.equal(f.manualStore.stage,'manual');assert.equal(f.messages.filter(x=>x.type==='test:reload').length,0);f.close();
});
test('等待时网站自行恢复则取消2分钟刷新',async()=>{
  const f=await fixture();const d=f.dialog('暂时错误');f.control('start');d.remove();f.video.media.paused=false;f.video.dispatchEvent(new f.w.Event('playing'));f.video.media.time=11;f.video.dispatchEvent(new f.w.Event('timeupdate'));await f.advance(180000);
  assert.equal(f.messages.filter(x=>x.type==='test:reload').length,0);assert.equal(f.control('status').phase,'playing');f.close();
});
test('恢复记录保存失败不会刷新且通知用户',async()=>{
  const f=await fixture({saveFails:true});f.dialog('暂时错误');f.control('start');await f.advance(180000);assert.equal(f.messages.filter(x=>x.type==='test:reload').length,0);assert.equal(f.control('status').phase,'manual');assert(f.messages.some(x=>x.type==='assistant:attention'));f.close();
});
