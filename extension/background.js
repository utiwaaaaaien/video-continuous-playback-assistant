'use strict';
const site = 'https://estudy.enaea.edu.cn/';
const powerKey = 'assistant:power-leases';
const powerAlarm = 'assistant:power-cleanup';
const leaseDuration = 120000;
let powerQueue = Promise.resolve();
let appliedPower = null;
const playerUrl = url => typeof url === 'string' && url.startsWith(`${site}web/player/`);

const nativeHost = 'org.codex.video_continuous_playback';
let nativePort = null;
let nativeCounter = 0;
let nativeRetryAt = 0;
let nativeReason = 'not-connected';
let nativeFailures = 0;
function nativeFailed(reason) {
  nativeFailures++;
  nativeRetryAt = nativeFailures >= 3 ? Infinity : Date.now() + 60000;
  dropNative(reason);
}
const nativePending = new Map();
function dropNative(reason) {
  nativeReason = reason;
  const port = nativePort; nativePort = null;
  for (const pending of nativePending.values()) {clearTimeout(pending.timer); pending.resolve({nativeActive:false, nativeStatus:reason});}
  nativePending.clear();
  try {port?.disconnect();} catch {}
}
async function setNativeAwake(active) {
  if (!active) {nativeFailures = 0; nativeRetryAt = 0;}
  if (!active && !nativePort) return {nativeActive:false, nativeStatus:'idle'};
  if (!nativePort && Date.now() < nativeRetryAt) return {nativeActive:false, nativeStatus:nativeReason};
  if (!nativePort) {
    try {
      const port = chrome.runtime.connectNative(nativeHost);
      nativePort = port;
      port.onMessage.addListener(reply => {
        const pending = nativePending.get(reply.id);
        if (!pending) return;
        clearTimeout(pending.timer); nativePending.delete(reply.id);
        nativeFailures = 0;
        nativeReason = reply.reason || (reply.ok ? 'ready' : 'power-unavailable');
        pending.resolve({nativeActive:reply.ok === true && reply.active === true, nativeStatus:nativeReason});
      });
      port.onDisconnect.addListener(() => {
        // Reading lastError consumes Chrome's unchecked runtime error.
        const reason = chrome.runtime.lastError?.message ? 'not-connected' : 'disconnected';
        if (nativePort !== port) return;
        nativeFailed(reason);
      });
    } catch {nativeFailed('not-connected'); return {nativeActive:false, nativeStatus:'not-connected'};}
  }
  const response = await new Promise(resolve => {
    const id = ++nativeCounter;
    const timer = setTimeout(() => {nativeFailed('timeout');}, 4000);
    nativePending.set(id, {resolve,timer});
    try {nativePort.postMessage({id,type:'set-awake',active,ttl:75});}
    catch {nativeFailed('disconnected');}
  });
  if (!active) dropNative('idle');
  return response;
}

// Serialize tab reports and cleanup so pausing one tab cannot release another.
function powerTask(update = () => {}) {
  const task = powerQueue.then(async () => {
    const stored = await chrome.storage.session.get(powerKey);
    const leases = stored[powerKey] || {};
    const now = Date.now();
    await update(leases, now);
    for (const [id, lease] of Object.entries(leases)) {
      if (!Number.isFinite(lease.expiresAt) || lease.expiresAt <= now || lease.expiresAt > now + leaseDuration) delete leases[id];
    }
    const active = Object.keys(leases).length > 0;
    if (active || active !== appliedPower) {
      if (active) chrome.power.requestKeepAwake('display');
      else chrome.power.releaseKeepAwake();
      appliedPower = active;
    }
    await chrome.storage.session.set({[powerKey]: leases});
    if (active) {
      if (!await chrome.alarms.get(powerAlarm)) await chrome.alarms.create(powerAlarm, {periodInMinutes: 0.5});
    } else await chrome.alarms.clear(powerAlarm);
    const native = await setNativeAwake(active);
    return {ok: true, active, ...native};
  }).catch(async error => {
    // A failed persistence/alarm operation must not leave an untracked request.
    try {chrome.power.releaseKeepAwake();} catch {}
    appliedPower = false;
    await setNativeAwake(false);
    try {await chrome.alarms.clear(powerAlarm);} catch {}
    throw error;
  });
  powerQueue = task.catch(() => {});
  return task;
}
// Session storage survives worker suspension. Verify retained tabs on restart.
powerTask(async leases => {
  for (const id of Object.keys(leases)) {
    try {if (!playerUrl((await chrome.tabs.get(Number(id))).url)) delete leases[id];}
    catch {delete leases[id];}
  }
}).catch(() => {});
async function probeTab(tabId, lease) {
  let timeout;
  try {
    return await Promise.race([
      chrome.tabs.sendMessage(tabId, {type: 'assistant:power-probe'}, lease.documentId ? {documentId: lease.documentId} : {}),
      new Promise(resolve => {timeout = setTimeout(() => resolve(null), 4000);})
    ]);
  } catch {return null;}
  finally {clearTimeout(timeout);}
}
let recoveryQueue=Promise.resolve();
function recoveryTask(operation) {
  const task=recoveryQueue.then(operation);
  recoveryQueue=task.catch(()=>{});
  return task;
}
async function notifyManual(id,reason) {
  await chrome.action.setBadgeText({tabId:id,text:'!'});
  await chrome.action.setBadgeBackgroundColor({tabId:id,color:'#B45309'});
  await chrome.notifications.create(`attention:${id}`,{type:'basic',iconUrl:'icon128.png',
    title:'视频连续播放助手 · 需要你处理',message:String(reason).slice(0,160)});
}
const manualAlarm=id=>`assistant:manual-recovery:${id}`;
async function scheduleManualAlarm(id,job) {
  if (!job || job.stage==='manual') {await chrome.alarms.clear(manualAlarm(id));return;}
  await chrome.alarms.create(manualAlarm(id),{when:Math.max(Date.now()+1000,job.stage==='waiting'?job.dueAt:job.checkUntil)});
}
function recoveryTarget(job,url) {
  if (!playerUrl(url)) return false;
  try {
    const p=new URL(url).searchParams;
    return `${p.get('project_id')||''}:${p.get('course_id')||''}`===job.course &&
      ['project_id','activity_id','plan_id'].map(k=>p.get(k)||'').join(':')===job.scope &&
      (p.get('resource_id')||'')===job.resource;
  } catch {return false;}
}
async function finishManualRecovery(id,state,reason) {
  state.manualRecovery.stage='manual';
  await chrome.storage.session.set({[`session:${id}`]:state});
  await chrome.alarms.clear(manualAlarm(id));
  await powerTask(leases=>{delete leases[id];});
  await notifyManual(id,reason);
  return {ok:false};
}
async function recoverManualTab(id,jobId) {
  const key=`session:${id}`,state=(await chrome.storage.session.get(key))[key];
  const job=state?.manualRecovery;
  if (job?.id===jobId && job.stage==='checking' && job.attempted && !job.feedback &&
      recoveryTarget(job,(await chrome.tabs.get(id)).url)) return {ok:true,job:{...job}};
  if (!job || job.id!==jobId || job.stage!=='waiting' || job.attempted || job.feedback || Date.now()<job.dueAt) return {ok:false};
  if (!recoveryTarget(job,(await chrome.tabs.get(id)).url)) {
    state.manualRecovery=null;await chrome.storage.session.set({[key]:state});
    await chrome.alarms.clear(manualAlarm(id));return {ok:false};
  }
  job.attempted=true;job.stage='checking';job.checkUntil=Date.now()+60000;
  state.enabled=true;state.pendingCourse=null;state.pendingEpisode=null;
  // Persist the used attempt before reloading. Both page and alarm use this queue.
  await chrome.storage.session.set({[key]:state});await scheduleManualAlarm(id,job);
  try {await chrome.tabs.reload(id);return {ok:true,job:{...job}};}
  catch {return finishManualRecovery(id,state,'自动刷新失败，请返回播放页手动处理。');}
}
async function retryWithoutPage(id, state) {
  const job=state.networkJob, now=Date.now();
  if (!job || !state.enabled) return;
  const name=`assistant:network-retry:${id}`;
  if (job.inFlight && now >= job.checkUntil) {
    if (job.attempts >= 3) {
      state.enabled=false; state.networkJob=null;
      await chrome.storage.session.set({[`session:${id}`]:state});
      await chrome.alarms.clear(name);
      const protection=await powerTask(leases=>{delete leases[id];});
      await chrome.notifications.create(`attention:${id}`,{type:'basic',iconUrl:'icon128.png',title:'视频连续播放助手 · 重试结束',message:protection.active?'网络重试3次未恢复，已停止本标签；其他播放标签的唤醒保护保留。':'网络重试3次未恢复，已停止并释放唤醒；系统将按现有设置锁屏。'});
      return;
    }
    job.inFlight=false; job.nextAttemptAt=job.startedAt+(job.attempts+1)*120000;
  }
  if (!job.inFlight && now >= job.nextAttemptAt) {
    job.attempts++; job.inFlight=true; job.checkUntil=now+30000;
    await chrome.storage.session.set({[`session:${id}`]:state});
    await chrome.alarms.create(name,{when:job.checkUntil});
    await chrome.tabs.reload(id);
    return;
  }
  await chrome.storage.session.set({[`session:${id}`]:state});
  await chrome.alarms.create(name,{when:Math.max(now+1000,job.inFlight?job.checkUntil:job.nextAttemptAt)});
}
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name.startsWith('assistant:manual-recovery:')) {
    const id=Number(alarm.name.split(':').at(-1));
    if (!Number.isInteger(id)) return;
    recoveryTask(async()=>{
      const key=`session:${id}`,state=(await chrome.storage.session.get(key))[key];
      const job=state?.manualRecovery;
      if (!job || job.stage==='manual') return;
      if (!recoveryTarget(job,(await chrome.tabs.get(id)).url)) {
        state.manualRecovery=null;await chrome.storage.session.set({[key]:state});
        await chrome.alarms.clear(manualAlarm(id));return;
      }
      if (job.stage==='waiting') {await recoverManualTab(id,job.id);return;}
      if (Date.now()<job.checkUntil) {await scheduleManualAlarm(id,job);return;}
      let timeout;
      try {
        const reply=await Promise.race([chrome.tabs.sendMessage(id,{type:'assistant:recovery-tick'},state.documentId?{documentId:state.documentId}:{}),
          new Promise(resolve=>{timeout=setTimeout(()=>resolve(null),4000);})]);
        if (reply?.ok) return;
      } catch {} finally {clearTimeout(timeout);}
      await finishManualRecovery(id,state,'自动刷新后播放页仍未恢复，请手动检查。');
    }).catch(()=>{});
    return;
  }
  if (alarm.name.startsWith('assistant:network-retry:')) {
    const id=Number(alarm.name.split(':').at(-1));
    if (!Number.isInteger(id)) return;
    (async()=>{
      const key=`session:${id}`;
      const data=(await chrome.storage.session.get(key))[key];
      if (!data?.enabled || !data.networkJob || !playerUrl((await chrome.tabs.get(id)).url)) return;
      let timeout;
      try {
        const reply=await Promise.race([
          chrome.tabs.sendMessage(id, {type:'assistant:network-tick'}, data.documentId ? {documentId:data.documentId} : {}),
          new Promise(resolve=>{timeout=setTimeout(()=>resolve(null),4000);})
        ]);
        if (reply?.ok) return;
      } catch {}
      finally {clearTimeout(timeout);}
      // An offline reload can show Chrome's error page without a content script.
      // The background continues the same persisted plan instead of losing it.
      const fresh=(await chrome.storage.session.get(key))[key];
      if (fresh?.enabled && fresh.networkJob?.id===data.networkJob.id &&
          fresh.networkJob.attempts===data.networkJob.attempts && fresh.documentId===data.documentId) await retryWithoutPage(id,fresh);
    })().catch(()=>{});
    return;
  }
  if (alarm.name !== powerAlarm) return;
  powerTask(async (leases, now) => {
    await Promise.all(Object.entries(leases).map(async ([id, lease]) => {
      // A handoff protects the small gap between documents; its deadline is fixed.
      if (lease.handoff) return;
      const reply = await probeTab(Number(id), lease);
      if (!reply || (lease.token && reply.documentToken !== lease.token)) {
        const state=(await chrome.storage.session.get(`session:${id}`))[`session:${id}`];
        if (state?.enabled && state.keepAwake !== false && state.networkJob &&
            now<=state.networkJob.startedAt+390000 && playerUrl((await chrome.tabs.get(Number(id))).url)) lease.expiresAt=now+leaseDuration;
        return;
      }
      if (reply.requested === true) lease.expiresAt = now + leaseDuration;
      else if (reply.requested === false) delete leases[id];
    }));
  }).catch(() => {});
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status !== 'loading' && !(change.url && !playerUrl(change.url))) return;
  powerTask(async (leases, now) => {
    const stored = await chrome.storage.session.get(`session:${tabId}`);
    const session = stored[`session:${tabId}`];
    const pending = session?.pendingCourse || session?.pendingEpisode;
    if (session?.enabled && session.keepAwake !== false && session.networkJob &&
        now<=session.networkJob.startedAt+390000 && (!change.url || playerUrl(change.url))) {
      leases[tabId]={owner:leases[tabId]?.owner || session.documentId || '',documentId:session.documentId,expiresAt:now+leaseDuration};
    } else if (leases[tabId] && session?.enabled && session.keepAwake !== false &&
        pending?.expiresAt > now && pending.expiresAt <= now + 65000 && (!change.url || playerUrl(change.url))) {
      leases[tabId].expiresAt = pending.expiresAt;
      leases[tabId].handoff = true;
    } else delete leases[tabId];
  }).catch(() => {});
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!sender.tab || !sender.url?.startsWith(site)) return;
  const key = `session:${sender.tab.id}`;
  (async () => {
    if (message.type === 'assistant:playback') {
      if (!playerUrl(sender.url) || (sender.documentLifecycle && sender.documentLifecycle !== 'active')) return {ok: false};
      const owner = sender.documentId || String(message.documentToken || '');
      if (!owner) return {ok: false};
      const result = await powerTask((leases, now) => {
        if (message.playing === true) leases[sender.tab.id] = {owner, documentId: sender.documentId || null, token: String(message.documentToken || ''), expiresAt: now + leaseDuration};
        else if (leases[sender.tab.id]?.owner === owner) {
          if (Number.isFinite(message.handoffUntil) && message.handoffUntil > now && message.handoffUntil <= now + 65000) {
            leases[sender.tab.id].expiresAt = message.handoffUntil; leases[sender.tab.id].handoff = true;
          } else delete leases[sender.tab.id];
        }
      });
      return {...result, active: message.playing === true && result.active};
    }
    if (message.type === 'assistant:get-session') {
      const result = await chrome.storage.session.get(key);
      return result[key] || {};
    }
    if (message.type === 'assistant:network-exhausted') {
      if (!playerUrl(sender.url) || message.attempts !== 3 || !Number.isFinite(message.startedAt) ||
          Date.now()-message.startedAt < 360000) return {ok:false};
      const owner=sender.documentId || String(message.documentToken || '');
      const result=await powerTask(leases=>{
        if (leases[sender.tab.id]?.owner===owner) delete leases[sender.tab.id];
      });
      await chrome.alarms.clear(`assistant:network-retry:${sender.tab.id}`);
      return {ok:true,locked:false,reason:result.active?'other-playback':'system-idle'};
    }
    if (message.type === 'assistant:recover-now') {
      return recoveryTask(()=>recoverManualTab(sender.tab.id,message.jobId));
    }
    if (message.type === 'assistant:save-session') {return recoveryTask(async()=>{ 
      const incoming = message.state || {};
      const pending = incoming.pendingCourse;
      const state = {course: String(incoming.course), enabled: !!incoming.enabled, autoConfirm: !!incoming.autoConfirm,
        documentId:sender.documentId || null,
        autoNextCourse: incoming.autoNextCourse !== false, keepAwake: incoming.keepAwake !== false, collapsed: incoming.collapsed === true,
        visitedCourses: Array.isArray(incoming.visitedCourses) ? incoming.visitedCourses.filter(value => typeof value === 'string').slice(-100) : [],
        pendingCourse: pending && Number.isFinite(pending.expiresAt) ? {
          fromCourse: String(pending.fromCourse), scope: String(pending.scope), fromSource: String(pending.fromSource || ''), fromDirectoryState: String(pending.fromDirectoryState || ''),
          attempts: Math.max(1, Math.min(3, Number(pending.attempts) || 1)), lastClickAt: Number(pending.lastClickAt) || 0,
          expiresAt: pending.expiresAt, clicked: !!pending.clicked, toCourse: pending.toCourse ? String(pending.toCourse) : null,
          expectedCourse: pending.expectedCourse ? String(pending.expectedCourse) : null
        } : null};
      const episode = incoming.pendingEpisode;
      state.pendingEpisode = episode && Number.isFinite(episode.expiresAt) ? {
        fromCourse: String(episode.fromCourse), scope: String(episode.scope), fromSource: String(episode.fromSource || ''),
        fromTitle: String(episode.fromTitle || ''), fromResource: String(episode.fromResource || ''), nextTitle: String(episode.nextTitle || ''),
        replay: !!episode.replay, expiresAt: episode.expiresAt,
        attempts: Math.max(1, Math.min(3, Number(episode.attempts) || 1)), lastClickAt: Number(episode.lastClickAt) || 0
      } : null;
      const retry=incoming.networkJob;
      state.networkJob=state.enabled && retry && typeof retry.id==='string' &&
        retry.course===state.course && typeof retry.scope==='string' && typeof retry.resource==='string' &&
        Number.isFinite(retry.startedAt) && retry.startedAt<=Date.now() &&
        Number.isInteger(retry.attempts) && retry.attempts>=0 && retry.attempts<=3 &&
        Number.isFinite(retry.nextAttemptAt) && Number.isFinite(retry.checkUntil) ? {
          id:retry.id,course:retry.course,scope:retry.scope,resource:retry.resource,title:String(retry.title || ''),
          startedAt:retry.startedAt,attempts:retry.attempts,nextAttemptAt:retry.nextAttemptAt,inFlight:retry.inFlight===true,checkUntil:retry.checkUntil
        } : null;
      const recovery=incoming.manualRecovery;
      const previous=(await chrome.storage.session.get(key))[key];
      state.manualRecovery=recovery && typeof recovery.id==='string' && recovery.course===state.course &&
        typeof recovery.scope==='string' && typeof recovery.resource==='string' &&
        ['waiting','checking','manual'].includes(recovery.stage) && Number.isFinite(recovery.dueAt) &&
        recovery.dueAt<=Date.now()+120000 && Number.isFinite(recovery.checkUntil) ? {
          id:recovery.id,course:recovery.course,scope:recovery.scope,resource:recovery.resource,reason:String(recovery.reason||''),
          stage:recovery.stage,attempted:recovery.attempted===true,feedback:recovery.feedback===true,
          dueAt:recovery.dueAt,checkUntil:recovery.checkUntil
        } : null;
      const old=previous?.manualRecovery,current=state.manualRecovery;
      if (old && current && old.id===current.id && old.attempted && !current.attempted && previous.documentId && sender.documentId && previous.documentId!==sender.documentId) return {ok:true};
      const rank={waiting:0,checking:1,manual:2};
      if (old && current && old.id===current.id && (rank[old.stage]>rank[current.stage] || old.attempted && !current.attempted || old.feedback && !current.feedback)) state.manualRecovery={...old};
      if (state.networkJob) state.manualRecovery=null;
      await chrome.storage.session.set({[key]: state});
      await scheduleManualAlarm(sender.tab.id,state.manualRecovery);
      const alarm=`assistant:network-retry:${sender.tab.id}`;
      if (state.networkJob) {
        const due=state.networkJob.inFlight ? state.networkJob.checkUntil : state.networkJob.nextAttemptAt;
        await chrome.alarms.create(alarm,{when:Math.max(Date.now()+1000,due)});
      } else await chrome.alarms.clear(alarm);
      return {ok: true};
    });}
    if (message.type === 'assistant:attention') {
      await notifyManual(sender.tab.id,message.reason || '请返回播放页面查看提示。');
      return {ok:true};
    }
    if (message.type === 'assistant:clear-attention') {
      await chrome.action.setBadgeText({tabId: sender.tab.id, text: ''});
      await chrome.notifications.clear(`attention:${sender.tab.id}`);
      return {ok: true};
    }
    return {ok: false};
  })().then(respond, error => respond({error: error.message}));
  return true;
});
chrome.tabs.onRemoved.addListener(tabId => {
  powerTask(leases => {delete leases[tabId];}).catch(() => {});
  chrome.storage.session.remove(`session:${tabId}`).catch(() => {});
  chrome.alarms.clear(`assistant:network-retry:${tabId}`).catch(() => {});
  chrome.alarms.clear(manualAlarm(tabId)).catch(()=>{});
});
chrome.notifications.onClicked.addListener(id => {
  if (!id.startsWith('attention:')) return;
  const tabId = Number(id.split(':')[1]);
  recoveryTask(async()=>{
    const key=`session:${tabId}`,state=(await chrome.storage.session.get(key))[key];
    if (state?.manualRecovery && state.manualRecovery.stage!=='manual') {
      state.manualRecovery.stage='manual';state.manualRecovery.feedback=true;
      await chrome.storage.session.set({[key]:state});await chrome.alarms.clear(manualAlarm(tabId));
      try {await chrome.tabs.sendMessage(tabId,{type:'assistant:recovery-feedback'});} catch {}
    }
  }).catch(()=>{});
  chrome.tabs.update(tabId, {active: true}).then(tab => {
    if (tab.windowId != null) chrome.windows.update(tab.windowId, {focused: true});
  }).catch(() => {});
});
