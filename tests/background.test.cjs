const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const vm = require('node:vm');
const script = readFileSync('extension/background.js', 'utf8');
function fixture({store = {}, powerFails = false, alarmFails = false, probeReply = null, nativeMode = null, reloadFails=false, notificationFails=false} = {}) {
  let handler, removal, update, alarm, notificationClick, now = 1000;
  const events = [], alarms = {}, tabs = new Map([[1, {url:'https://estudy.enaea.edu.cn/web/player/project'}], [2, {url:'https://estudy.enaea.edu.cn/web/player/project'}]]);
  const chrome = {
    runtime: {connectNative: () => {
      if(!nativeMode) throw new Error('not installed');
      let message, disconnect;
      return {onMessage:{addListener:f=>message=f},onDisconnect:{addListener:f=>disconnect=f},
        postMessage: input => {events.push({native:input.active}); if(nativeMode==='disconnect') disconnect(); else message({id:input.id,ok:true,active:input.active,reason:'ready'});}, disconnect:()=>{}};
    }, onMessage: {addListener: f => handler = f}},
    storage: {session: {get: async key => ({[key]: store[key]}), set: async object => Object.assign(store, object), remove: async key => delete store[key]}},
    power: {requestKeepAwake: level => {if (powerFails) throw new Error('power unavailable'); events.push({power:level});}, releaseKeepAwake: () => events.push({power:'release'})},
    alarms: {get: async key => alarms[key], create: async (key, value) => {if(alarmFails) throw new Error('alarm unavailable'); alarms[key] = value;}, clear: async key => delete alarms[key], onAlarm: {addListener: f => alarm = f}},
    action: {setBadgeText: async x => events.push(x), setBadgeBackgroundColor: async () => {}},
    notifications: {create: async (id, data) => {if(notificationFails)throw new Error('notifications disabled');events.push({id, data});}, clear: async () => {}, onClicked: {addListener:f=>notificationClick=f}},
    tabs: {reload: async id=>{if(reloadFails)throw new Error('reload failed');events.push({reload:id});}, sendMessage: async () => {if(probeReply) return probeReply; throw new Error('page unavailable');}, get: async id => {if (!tabs.has(id)) throw new Error('missing'); return tabs.get(id);}, onRemoved: {addListener: f => removal = f}, onUpdated: {addListener: f => update = f}, update: async () => ({windowId: 1})}, windows: {update: async () => {}}
  };
  vm.runInNewContext(script, {chrome, URL, Date: {now: () => now}, setTimeout, clearTimeout});
  const flush = async () => {for (let i = 0; i < 50; i++) await Promise.resolve();};
  const call = (message, id = 1, owner = 'doc1', extra = {}) => new Promise(resolve => handler(message, {url: tabs.get(id)?.url || 'https://estudy.enaea.edu.cn/web/player/project', documentId: owner, tab: {id}, ...extra}, resolve));
  return {store, events, alarms, tabs, call, flush, clickNotification:id=>notificationClick(id), remove: id => removal(id), update: (id, change) => update(id, change), advance: ms => {now += ms; alarm({name:'assistant:power-cleanup'});}, fire: name=>alarm({name})};
}
test('后台会话按标签页隔离，支持提醒和关闭后清理', async () => {
  const f = fixture(); await f.flush();
  await f.call({type: 'assistant:save-session', state: {course: 'p:c', enabled: true, autoConfirm: true, autoNextCourse: true, keepAwake: false,
    visitedCourses: ['p:c'], pendingCourse: {fromCourse: 'p:c', scope: 'p::', fromSource: 'blob:first', fromDirectoryState:'[{"complete":true,"percent":100,"checked":true}]', expiresAt: 30000, clicked: true}}});
  const restored = await f.call({type:'assistant:get-session'});
  assert.equal(restored.enabled, true); assert.equal(restored.keepAwake, false);
  assert.equal(restored.pendingCourse.fromDirectoryState,'[{"complete":true,"percent":100,"checked":true}]');
  assert.equal(restored.autoNextCourse, true); assert.equal(restored.pendingCourse.clicked, true); assert.equal(restored.pendingCourse.scope, 'p::');
  assert.equal(Object.keys(await f.call({type:'assistant:get-session'}, 2)).length, 0);
  await f.call({type:'assistant:attention', reason:'请手动答题'}); assert(f.events.some(event => event.id === 'attention:1'));
  f.remove(1); await f.flush(); assert.equal(f.store['session:1'], undefined);
});
test('播放请求显示级唤醒，暂停释放并清理闹钟', async () => {
  const f = fixture(); await f.flush();
  const result = await f.call({type:'assistant:playback', playing:true}); assert.equal(result.active, true);
  assert.equal(f.events.at(-1).power, 'display'); assert(f.alarms['assistant:power-cleanup']);
  await f.call({type:'assistant:playback', playing:false}); assert.equal(f.events.at(-1).power, 'release'); assert.equal(Object.keys(f.alarms).length, 0);
});
test('多标签页独立持有唤醒；关闭最后播放标签页释放', async () => {
  const f = fixture(); await f.flush();
  await Promise.all([f.call({type:'assistant:playback', playing:true}), f.call({type:'assistant:playback', playing:true}, 2)]);
  await f.call({type:'assistant:playback', playing:false}); assert.equal(f.events.at(-1).power, 'display');
  f.remove(2); await f.flush(); assert.equal(f.events.at(-1).power, 'release');
});
test('导航立即清理；旧页面释放不能撤销新页面请求', async () => {
  const f = fixture(); await f.flush(); await f.call({type:'assistant:playback', playing:true});
  f.update(1, {status:'loading'}); await f.flush(); assert.equal(f.events.at(-1).power, 'release');
  await f.call({type:'assistant:playback', playing:true}, 1, 'newdoc');
  await f.call({type:'assistant:playback', playing:false}, 1, 'doc1'); assert.equal(f.events.at(-1).power, 'display');
  f.update(1, {url:'https://example.com/'}); await f.flush(); assert.equal(f.events.at(-1).power, 'release');
});
test('失去心跳的播放请求过期；心跳可以延长租期', async () => {
  const f = fixture(); await f.flush(); await f.call({type:'assistant:playback', playing:true});
  f.advance(60000); await f.flush(); assert.equal(f.events.at(-1).power, 'display');
  await f.call({type:'assistant:playback', playing:true}); f.advance(60000); await f.flush(); assert.equal(f.events.at(-1).power, 'display');
  f.advance(61000); await f.flush(); assert.equal(f.events.at(-1).power, 'release');
});
test('后台重启恢复有效租期并重建清理闹钟，移除失效标签页', async () => {
  const f = fixture({store:{'assistant:power-leases':{'1':{owner:'doc',expiresAt:80000},'3':{owner:'gone',expiresAt:80000}}}});
  await f.flush(); assert.equal(f.events.at(-1).power, 'display'); assert(f.alarms['assistant:power-cleanup']); assert.equal(f.store['assistant:power-leases']['3'], undefined);
  f.advance(80000); await f.flush(); assert.equal(f.events.at(-1).power, 'release');
});
test('重启清除过期或异常租期，拒绝非播放页和非活动文档', async () => {
  const f = fixture({store:{'assistant:power-leases':{'1':{expiresAt:999},'2':{expiresAt:9999999}}}}); await f.flush();
  assert.equal(f.events.at(-1).power, 'release');
  assert.equal((await f.call({type:'assistant:playback', playing:true}, 1, 'doc', {url:'https://estudy.enaea.edu.cn/home'})).ok, false);
  assert.equal((await f.call({type:'assistant:playback', playing:true}, 1, 'doc', {documentLifecycle:'cached'})).ok, false);
});
test('电源接口失败明确报告错误，后续消息仍能处理', async () => {
  const f = fixture({powerFails:true}); await f.flush();
  assert.match((await f.call({type:'assistant:playback', playing:true})).error, /unavailable/);
  assert.equal((await f.call({type:'assistant:playback', playing:false})).ok, true);
});

test('清理闹钟建立失败时释放已请求的唤醒，避免失去清理保障', async () => {
  const f=fixture({alarmFails:true}); await f.flush();
  const result=await f.call({type:'assistant:playback',playing:true});
  assert.match(result.error,/alarm unavailable/); assert.equal(f.events.at(-1).power,'release');
});

test('页面计时器被节流时后台探测保持有效租期并重新申请电源', async () => {
  const f=fixture({probeReply:{requested:true,documentToken:'token'}});await f.flush();
  await f.call({type:'assistant:playback',playing:true,documentToken:'token'});
  f.advance(130000);await f.flush();assert.equal(f.events.at(-1).power,'display');
  assert(f.store['assistant:power-leases']['1'].expiresAt>130000);
});
test('后台探测到暂停时释放，不等待旧租期结束', async () => {
  const f=fixture({probeReply:{requested:false,documentToken:'token'}});await f.flush();
  await f.call({type:'assistant:playback',playing:true,documentToken:'token'});f.advance(30000);await f.flush();assert.equal(f.events.at(-1).power,'release');
});
test('跨文档自动导航保持有限保护，结束后正常释放', async () => {
  const f=fixture();await f.flush();
  await f.call({type:'assistant:save-session',state:{course:'p:c',enabled:true,keepAwake:true,pendingEpisode:{fromCourse:'p:c',scope:'p::',nextTitle:'第二集',expiresAt:45000}}});
  await f.call({type:'assistant:playback',playing:true});f.update(1,{status:'loading'});await f.flush();assert.equal(f.events.at(-1).power,'display');
  f.advance(46000);await f.flush();assert.equal(f.events.at(-1).power,'release');
});
test('本地组件确认后才返回本地保护，停止发送释放并断开', async () => {
  const f=fixture({nativeMode:'ready'});await f.flush();
  const result=await f.call({type:'assistant:playback',playing:true});assert.equal(result.nativeActive,true);
  await f.call({type:'assistant:playback',playing:false});assert.equal(f.events.filter(x=>'native'in x).at(-1).native,false);
});
test('本地组件断开时浏览器保护继续且明确报告未连接', async () => {
  const f=fixture({nativeMode:'disconnect'});await f.flush();
  const result=await f.call({type:'assistant:playback',playing:true});assert.equal(result.active,true);assert.equal(result.nativeActive,false);
});

test('本地组件连续失败三次后停止自动重试，用户停止后可重新连接', async () => {
  const f=fixture({nativeMode:'disconnect'});await f.flush();
  await f.call({type:'assistant:playback',playing:true});
  for(let i=0;i<5;i++){f.advance(61000);await f.flush();await f.call({type:'assistant:playback',playing:true});}
  assert.equal(f.events.filter(x=>'native'in x).length,3);
  await f.call({type:'assistant:playback',playing:false});
  await f.call({type:'assistant:playback',playing:true});
  assert.equal(f.events.filter(x=>'native'in x).length,4);
});

test('后台保存网络重试计划并建立2分钟定时，停止后清除', async()=>{
  const f=fixture();await f.flush();
  await f.call({type:'assistant:save-session',state:{course:'p:c',enabled:true,networkJob:{id:'job',course:'p:c',scope:'p::',resource:'1',startedAt:1000,attempts:0,nextAttemptAt:121000,checkUntil:0,inFlight:false}}});
  assert.equal(f.alarms['assistant:network-retry:1'].when,121000);
  assert.equal((await f.call({type:'assistant:get-session'})).networkJob.attempts,0);
  await f.call({type:'assistant:save-session',state:{course:'p:c',enabled:false}});assert.equal(f.alarms['assistant:network-retry:1'],undefined);
});
test('网络终止释放当前保护，其他播放标签存在时保留它的保护', async()=>{
  const f=fixture({nativeMode:'ready'});await f.flush();
  await f.call({type:'assistant:playback',playing:true});
  f.advance(360000);await f.flush();
  await f.call({type:'assistant:playback',playing:true},2);
  const result=await f.call({type:'assistant:network-exhausted',attempts:3,startedAt:1000});
  assert.equal(result.reason,'other-playback');assert.equal(f.events.filter(x=>'power'in x).at(-1).power,'display');
  await f.call({type:'assistant:playback',playing:false},2);
  assert.equal((await f.call({type:'assistant:network-exhausted',attempts:3,startedAt:1000})).reason,'system-idle');
});
test('未达到12分钟或不足3次的终止请求被拒绝',async()=>{
  const f=fixture();await f.flush();assert.equal((await f.call({type:'assistant:network-exhausted',attempts:3,startedAt:1000})).ok,false);
  f.advance(360000);await f.flush();assert.equal((await f.call({type:'assistant:network-exhausted',attempts:2,startedAt:1000})).ok,false);
});

test('刷新进入浏览器离线错误页后，后台仍按4、6分钟重试并结束',async()=>{
  const f=fixture({store:{'session:1':{course:'p:c',enabled:true,keepAwake:true,documentId:'doc1',networkJob:{id:'job',course:'p:c',scope:'p::',resource:'1',startedAt:1000,attempts:1,nextAttemptAt:121000,inFlight:true,checkUntil:151000}}}});await f.flush();
  f.advance(150000);f.fire('assistant:network-retry:1');await f.flush();
  assert.equal(f.alarms['assistant:network-retry:1'].when,241000);
  f.advance(90000);f.fire('assistant:network-retry:1');await f.flush();assert.equal(f.events.filter(x=>'reload'in x).length,1);assert.equal(f.store['session:1'].networkJob.attempts,2);
  f.advance(30000);f.fire('assistant:network-retry:1');await f.flush();assert.equal(f.alarms['assistant:network-retry:1'].when,361000);
  f.advance(90000);f.fire('assistant:network-retry:1');await f.flush();assert.equal(f.events.filter(x=>'reload'in x).length,2);assert.equal(f.store['session:1'].networkJob.attempts,3);
  f.advance(30000);f.fire('assistant:network-retry:1');await f.flush();assert.equal(f.store['session:1'].enabled,false);assert.equal(f.alarms['assistant:network-retry:1'],undefined);assert.equal(f.events.filter(x=>'power'in x).at(-1).power,'release');
});
test('离线刷新没有页面心跳时在重试窗口内续期，超过窗口后释放',async()=>{
  const f=fixture({store:{'session:1':{enabled:true,keepAwake:true,documentId:'doc1',networkJob:{startedAt:1000}}}});await f.flush();
  await f.call({type:'assistant:playback',playing:true});f.update(1,{status:'loading'});await f.flush();
  f.advance(120000);await f.flush();assert.equal(f.events.filter(x=>'power'in x).at(-1).power,'display');
  f.advance(271000);await f.flush();assert.equal(f.events.filter(x=>'power'in x).at(-1).power,'release');
});

const recoveryState=(stage='waiting')=>({course:'p:c',enabled:true,autoConfirm:true,manualRecovery:{id:'r',course:'p:c',scope:'p::',resource:'1',reason:'需人工处理',stage,attempted:stage!=='waiting',feedback:false,dueAt:121000,checkUntil:stage==='checking'?181000:0}});
const recoveryUrl='https://estudy.enaea.edu.cn/web/player/project?project_id=p&course_id=c&resource_id=1';
test('保存人工恢复后建立2分钟闹钟，未到截止时间不刷新',async()=>{
  const f=fixture();await f.flush();f.tabs.set(1,{url:recoveryUrl});await f.call({type:'assistant:save-session',state:recoveryState()});
  assert.equal(f.alarms['assistant:manual-recovery:1'].when,121000);
  assert.equal((await f.call({type:'assistant:recover-now',jobId:'r'})).ok,false);assert.equal(f.events.filter(e=>'reload'in e).length,0);
});
test('页面和后台并发到期请求仅刷新一次，先保存已用标记',async()=>{
  const f=fixture();await f.flush();f.tabs.set(1,{url:recoveryUrl});await f.call({type:'assistant:save-session',state:recoveryState()});f.advance(120000);await f.flush();
  const results=await Promise.all([f.call({type:'assistant:recover-now',jobId:'r'}),f.call({type:'assistant:recover-now',jobId:'r'})]);
  assert.equal(results.filter(r=>r.ok).length,2);assert.equal(f.events.filter(e=>'reload'in e).length,1);assert.equal(f.store['session:1'].manualRecovery.attempted,true);assert.equal(f.alarms['assistant:manual-recovery:1'].when,181000);
});
test('内容脚本缺失时闹钟刷新一次，刷新后仍缺失则通知且不再次刷新',async()=>{
  const f=fixture();await f.flush();f.tabs.set(1,{url:recoveryUrl});await f.call({type:'assistant:save-session',state:recoveryState()});f.advance(120000);f.fire('assistant:manual-recovery:1');await f.flush();
  assert.equal(f.events.filter(e=>'reload'in e).length,1);f.advance(60000);f.fire('assistant:manual-recovery:1');await f.flush();
  assert.equal(f.store['session:1'].manualRecovery.stage,'manual');assert.equal(f.alarms['assistant:manual-recovery:1'],undefined);assert(f.events.some(e=>e.id==='attention:1'));f.fire('assistant:manual-recovery:1');await f.flush();assert.equal(f.events.filter(e=>'reload'in e).length,1);
});
test('用户换课程或停止助手时清除普通恢复闹钟，不刷新新页面',async()=>{
  const f=fixture();await f.flush();f.tabs.set(1,{url:recoveryUrl});await f.call({type:'assistant:save-session',state:recoveryState()});f.tabs.set(1,{url:recoveryUrl.replace('course_id=c','course_id=other')});f.advance(120000);f.fire('assistant:manual-recovery:1');await f.flush();
  assert.equal(f.events.filter(e=>'reload'in e).length,0);assert.equal(f.store['session:1'].manualRecovery,null);
  await f.call({type:'assistant:save-session',state:{course:'p:c',enabled:false}});assert.equal(f.alarms['assistant:manual-recovery:1'],undefined);
});
test('通知点击被视为反馈，取消刷新并定位标签',async()=>{
  const f=fixture();await f.flush();f.tabs.set(1,{url:recoveryUrl});await f.call({type:'assistant:save-session',state:recoveryState()});f.clickNotification('attention:1');await f.flush();
  assert.equal(f.store['session:1'].manualRecovery.feedback,true);assert.equal(f.alarms['assistant:manual-recovery:1'],undefined);f.advance(120000);assert.equal((await f.call({type:'assistant:recover-now',jobId:'r'})).ok,false);assert.equal(f.events.filter(e=>'reload'in e).length,0);
});
test('旧页面等待记录不能覆盖已刷新标记或新文档归属',async()=>{
  const f=fixture();await f.flush();f.tabs.set(1,{url:recoveryUrl});await f.call({type:'assistant:save-session',state:recoveryState()});f.advance(120000);await f.call({type:'assistant:recover-now',jobId:'r'});
  await f.call({type:'assistant:save-session',state:recoveryState('checking')},1,'newdoc');
  await f.call({type:'assistant:save-session',state:recoveryState()},1,'doc1');
  assert.equal(f.store['session:1'].manualRecovery.stage,'checking');assert.equal(f.store['session:1'].documentId,'newdoc');assert.equal((await f.call({type:'assistant:recover-now',jobId:'r'})).job.stage,'checking');assert.equal(f.events.filter(e=>'reload'in e).length,1);
});
test('刷新失败进入人工处理并通知，不无限重试',async()=>{
  const f=fixture({reloadFails:true});await f.flush();f.tabs.set(1,{url:recoveryUrl});await f.call({type:'assistant:save-session',state:recoveryState()});f.advance(120000);await f.call({type:'assistant:recover-now',jobId:'r'});
  assert.equal(f.store['session:1'].manualRecovery.stage,'manual');assert(f.events.some(e=>e.id==='attention:1'));assert.equal(f.alarms['assistant:manual-recovery:1'],undefined);
});
test('通知接口不可用仍保存人工处理状态并停止刷新',async()=>{
  const f=fixture({reloadFails:true,notificationFails:true});await f.flush();f.tabs.set(1,{url:recoveryUrl});await f.call({type:'assistant:save-session',state:recoveryState()});f.advance(120000);const reply=await f.call({type:'assistant:recover-now',jobId:'r'});
  assert.match(reply.error,/notifications disabled/);assert.equal(f.store['session:1'].manualRecovery.stage,'manual');assert.equal(f.alarms['assistant:manual-recovery:1'],undefined);
});
test('关闭标签清理人工恢复记录和闹钟',async()=>{
  const f=fixture();await f.flush();f.tabs.set(1,{url:recoveryUrl});await f.call({type:'assistant:save-session',state:recoveryState()});f.remove(1);await f.flush();assert.equal(f.store['session:1'],undefined);assert.equal(f.alarms['assistant:manual-recovery:1'],undefined);
});

test('声明网站主机权限使后台可核对标签地址，内容脚本仍限定播放页',()=>{
  const manifest=JSON.parse(readFileSync('extension/manifest.json','utf8'));
  assert.deepEqual(manifest.host_permissions,['https://estudy.enaea.edu.cn/*']);
  assert.deepEqual(manifest.content_scripts[0].matches,['https://estudy.enaea.edu.cn/web/player/*']);
  assert.equal(manifest.permissions.includes('tabs'),false);
});
test('后台闹钟先执行后页面请求返回已刷新状态，不误报失败或二次刷新',async()=>{
  const f=fixture();await f.flush();f.tabs.set(1,{url:recoveryUrl});await f.call({type:'assistant:save-session',state:recoveryState()});f.advance(120000);f.fire('assistant:manual-recovery:1');await f.flush();
  const reply=await f.call({type:'assistant:recover-now',jobId:'r'});
  assert.equal(reply.ok,true);assert.equal(reply.job.stage,'checking');assert.equal(reply.job.attempted,true);assert.equal(f.events.filter(e=>'reload'in e).length,1);
});
