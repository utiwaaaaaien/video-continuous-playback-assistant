(() => {
  'use strict';
  if (document.getElementById('course-assistant-host')) return;
  const Core = globalThis.CourseAssistantCore;
  const ROW = '[class*="item-wrap_"]';
  const TITLE = '[class*="name-span_"]';
  const MODAL = '[role="dialog"], .ant-modal-content, .el-dialog, .arco-modal, [class*="modal-content"], [class*="dialog-content"]';
  const state = {enabled: false, autoConfirm: true, autoNextCourse: true, keepAwake: true, collapsed: false, visitedCourses: [], phase: 'idle', reason: '', logs: []};
  const label = {idle: '尚未启用', ready: '已启用 · 等待播放', playing: '连续播放中', paused: '视频已暂停', switching: '正在切换下一集', course: '正在进入下一个课程', manual: '等待你手动处理', last: '本课程播放结束', network: '网络错误 · 等待自动重试', error: '已停止 · 需要检查'};
  let course = courseKey();
  let video = null;
  let videoContext = '';
  let generation = 0;
  let timer = null;
  let switchJob = null;
  let pendingCourse = null;
  let pendingEpisode = null;
  let mediaCycle = 0;
  let loadedCycle = -1;
  let courseOriginVideo = null;
  let courseOriginCycle = 0;
  let courseOriginRows = null;
  let courseTimer = null;
  let saveQueue = Promise.resolve();
  let observerTimer = null;
  let panel;
  let ui;
  const handledEnds = new Set();
  const confirmed = new WeakMap();
  const removers = [];
  const repeatProgress = new Map();
  const documentToken = crypto.randomUUID();
  let wakeActive = false;
  let nativeActive = false;
  let nativeStatus = 'idle';
  let wakeError = false;
  let wakeDesired = null;
  let wakeReportedAt = -Infinity;
  let wakeRevision = 0;
  let pageHidden = false;
  let markedPlayer = null;
  let lastMotionAt = -Infinity;
  let lastMotionTime = null;
  let lastMotionVideo = null;
  let lastWakeAck = -Infinity;
  const retryInterval = 120000;
  const retryGrace = 30000;
  let networkJob = null;
  let networkTimer = null;
  let networkBusy = false;
  let recoveryBaseline = null;
  let recoveryPlaying = false;
  let manualRecovery = null;
  let manualTimer = null;
  let manualBusy = false;
  let manualBaseline = null;
  let manualPlayAttempted = false;

  function wantsAwake() {
    if (pageHidden || !state.enabled || !state.keepAwake || ['manual','error','last','idle'].includes(state.phase)) return false;
    if (pendingCourse || pendingEpisode || switchJob) return true;
    if (networkJob) return true;
    return !!video?.isConnected && !video.paused && !video.ended && !video.error &&
      (video.readyState >= 2 || Date.now() - lastMotionAt < 90000);
  }

  function syncMedia() {
    const playing = !pageHidden && !!video?.isConnected && !video.paused && !video.ended && !video.error && video.readyState >= 2;
    const player = video?.closest('.xgplayer');
    if (markedPlayer && (markedPlayer !== player || !playing)) {
      markedPlayer.removeAttribute('data-course-assistant-playing');
      markedPlayer = null;
    }
    // Only the inspected xgplayer central start control is hidden. Toolbar,
    // buffering indicators and question dialogs keep the website's behavior.
    if (playing && player) {
      player.setAttribute('data-course-assistant-playing', 'true');
      markedPlayer = player;
    }
    if (playing && (video !== lastMotionVideo || video.currentTime !== lastMotionTime)) {
      lastMotionAt = Date.now(); lastMotionTime = video.currentTime; lastMotionVideo = video;
    }
    const desired = wantsAwake();
    if (wakeActive && Date.now() - lastWakeAck > 45000) wakeActive = false;
    if (desired === wakeDesired && (!desired || Date.now() - wakeReportedAt < 15000)) return;
    wakeDesired = desired;
    wakeReportedAt = Date.now();
    const revision = ++wakeRevision;
    if (!desired) {wakeActive = false; nativeActive = false;}
    request({type: 'assistant:playback', playing: desired, documentToken, handoffUntil: pageHidden ? (pendingCourse?.expiresAt || pendingEpisode?.expiresAt || 0) : 0}).then(result => {
      if (revision !== wakeRevision) return;
      wakeActive = desired && result?.ok === true && result.active === true;
      if (wakeActive) lastWakeAck = Date.now();
      nativeActive = desired && result?.nativeActive === true;
      nativeStatus = result?.nativeStatus || 'not-connected';
      wakeError = desired && !wakeActive;
      render();
    });
  }
  function awakeText() {
    if (!state.keepAwake) return '保持唤醒：已关闭';
    if (wakeError && wakeDesired) return '保持唤醒：未能开启，请重新加载扩展和页面';
    if (wakeActive) {
      const protection = nativeActive ? 'Mac 本地保护 + 浏览器保护' : nativeStatus === 'locked' ? 'Mac 已锁定 · 等待手动解锁' : '浏览器保护 · Mac 组件未连接';
      return `${pendingCourse || pendingEpisode || switchJob ? '切换保护中' : '保持唤醒'} · ${protection}`;
    }
    return wakeDesired ? '正在确认唤醒保护…' : '保持唤醒：等待播放';
  }

  function courseKey() {
    const params = new URL(location.href).searchParams;
    return `${params.get('project_id') || ''}:${params.get('course_id') || ''}`;
  }
  function scopeKey() {
    const params = new URL(location.href).searchParams;
    return ['project_id', 'activity_id', 'plan_id'].map(key => params.get(key) || '').join(':');
  }
  function source() { return video?.currentSrc || video?.getAttribute('src') || ''; }
  function rows() {
    return [...document.querySelectorAll(ROW)].filter(row =>
      row.querySelector(TITLE) &&
      row.querySelector('[class*="rate-wrap_"]') && [null, 'true', 'false'].includes(row.getAttribute('data-checked')));
  }
  function title(row) { return Core.normalize(row?.querySelector(TITLE)?.textContent || row?.textContent).split(/\s*\d+%/)[0]; }
  function currentRow() {
    const listing = rows();
    const checked = listing.filter(row => row.getAttribute('data-checked') === 'true');
    return checked.length === 1 ? checked[0] : checked.length === 0 && listing.length === 1 ? listing[0] : null;
  }
  function directoryState(listing = rows()) {
    // Use the website's completion/selection state, never episode labels.
    return JSON.stringify(listing.map(row => {
      const {complete, percent} = rowProgress(row);
      return {complete, percent, checked: row.getAttribute('data-checked') === 'true'};
    }));
  }
  function freshCourseDirectory(listing) {
    // A restored handoff has a fresh document. In an SPA wait for rebuilt rows
    // or changed progress so old completed rows cannot skip the new course.
    return !courseOriginRows || !pendingCourse.fromDirectoryState ||
      listing.length !== courseOriginRows.length ||
      listing.some((row, index) => row !== courseOriginRows[index]) ||
      directoryState(listing) !== pendingCourse.fromDirectoryState;
  }
  function rowProgress(row) { return Core.directoryProgress(row?.querySelector('[class*="rate-wrap_"]')?.textContent); }
  function directoryStatus() {
    const listing = rows();
    const incomplete = listing.filter(row => !rowProgress(row).complete);
    return {complete: listing.length > 0 && incomplete.length === 0, incomplete, count: listing.length, completedCount: listing.length - incomplete.length};
  }
  function progressSnapshot() {
    const currentTime = Number.isFinite(video?.currentTime) ? Math.max(0, video.currentTime) : null;
    const duration = Number.isFinite(video?.duration) && video.duration > 0 ? video.duration : null;
    const directory = rowProgress(currentRow());
    const listing = directoryStatus();
    return {currentTime, duration, playbackPercent: currentTime != null && duration ? Math.min(100, currentTime / duration * 100) : null,
      directoryPercent: directory.percent, directoryComplete: directory.complete, completedCount: listing.completedCount, episodeCount: listing.count};
  }
  function timeText(value) {
    if (value == null) return '--:--';
    const seconds = Math.floor(value);
    return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
  }
  function progressText(progress) {
    const percentage = progress.playbackPercent == null ? '--' : progress.playbackPercent.toFixed(1);
    const directory = progress.directoryComplete ? '完成' : progress.directoryPercent == null ? '待识别' : `${progress.directoryPercent}%`;
    return `播放条 ${timeText(progress.currentTime)} / ${timeText(progress.duration)}（${percentage}%）\n目录当前集：${directory} · 已完成 ${progress.completedCount}/${progress.episodeCount} 集`;
  }
  function nextCourseTarget() {
    const exact = element => /^(下一个课程|下个课程)$/.test(Core.normalize(element.textContent));
    let found = [...document.querySelectorAll('[class*="next-btn_"]')].filter(element => visible(element) && exact(element));
    if (!found.length) found = [...document.querySelectorAll('a, button, [role="button"]')].filter(element => visible(element) && exact(element));
    found = [...new Set(found)];
    if (!found.length) return {kind: 'missing'};
    if (found.length !== 1) return {kind: 'ambiguous'};
    const element = found[0];
    if (element.closest('[disabled], [aria-disabled="true"], [data-disabled="true"]') || /(^|[\s_-])disabled([\s_-]|$)/i.test(element.className) || getComputedStyle(element).pointerEvents === 'none') return {kind: 'disabled'};
    const href = element.getAttribute('href');
    let expectedCourse = null;
    if (href && !href.startsWith('#')) {
      try {
        const url = new URL(href, location.href);
        if (url.origin !== location.origin || !url.pathname.startsWith('/web/player/') || ['project_id', 'activity_id', 'plan_id'].some(key => url.searchParams.get(key) !== new URL(location.href).searchParams.get(key))) return {kind: 'unsafe'};
        if (url.searchParams.get('course_id')) expectedCourse = `${url.searchParams.get('project_id') || ''}:${url.searchParams.get('course_id')}`;
      } catch { return {kind: 'unsafe'}; }
    }
    return {kind: 'ready', element, expectedCourse};
  }
  function context() {
    return `${courseKey()}|${new URL(location.href).searchParams.get('resource_id') || ''}|${title(currentRow())}|${video?.currentSrc || video?.getAttribute('src') || ''}`;
  }
  function visible(element) {
    if (!element?.isConnected || element.closest('#course-assistant-host')) return false;
    if (!element.getClientRects().length) return false;
    for (let node = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility) ||
          style.opacity === '0' || node.getAttribute('aria-hidden') === 'true' || node.hidden) return false;
    }
    return true;
  }
  function log(message) {
    state.logs.unshift(`${new Date().toLocaleTimeString('zh-CN', {hour12: false})} ${message}`);
    state.logs.length = Math.min(30, state.logs.length);
    render();
  }
  function request(message) {
    try { return chrome.runtime.sendMessage(message).catch(() => ({})); }
    catch { return Promise.resolve({}); }
  }
  function save() {
    const data = {course, enabled: state.enabled, autoConfirm: state.autoConfirm, autoNextCourse: state.autoNextCourse, keepAwake: state.keepAwake,
      pendingEpisode: pendingEpisode ? {...pendingEpisode} : null, collapsed: state.collapsed,
      networkJob: networkJob ? {...networkJob} : null,
      manualRecovery: manualRecovery ? {...manualRecovery} : null,
      visitedCourses: state.visitedCourses.slice(), pendingCourse: pendingCourse ? {...pendingCourse} : null};
    saveQueue = saveQueue.then(() => request({type: 'assistant:save-session', state: data}));
    return saveQueue;
  }
  function cancelPending() {
    generation++;
    clearTimeout(timer);
    clearTimeout(courseTimer);
    timer = null;
    switchJob = null;
    pendingCourse = null;
    pendingEpisode = null;
    courseTimer = null;
  }
  function setPhase(phase, reason = '') {
    state.phase = phase;
    state.reason = reason;
    render();
  }
  function clearManualRecovery() {
    clearTimeout(manualTimer); manualTimer=null; manualRecovery=null;
    manualBusy=false; manualBaseline=null; manualPlayAttempted=false;
  }
  function scheduleManualRecovery() {
    clearTimeout(manualTimer);
    if (!manualRecovery || manualRecovery.stage==='manual') return;
    const due=manualRecovery.stage==='waiting' ? manualRecovery.dueAt : Math.min(manualRecovery.checkUntil,Date.now()+1000);
    manualTimer=setTimeout(()=>{manualTimer=null; pollManualRecovery();},Math.max(0,due-Date.now()));
  }
  function startManualRecovery(reason, allowed=true) {
    if (!allowed || (!state.enabled && !manualRecovery)) return;
    if (!manualRecovery) manualRecovery={id:crypto.randomUUID(),course:courseKey(),scope:scopeKey(),
      resource:new URL(location.href).searchParams.get('resource_id') || '',reason,
      stage:'waiting',attempted:false,feedback:false,dueAt:Date.now()+120000,checkUntil:0};
    scheduleManualRecovery();
  }
  function manualFeedback() {
    if (!manualRecovery || manualRecovery.stage==='manual') return;
    clearTimeout(manualTimer); manualTimer=null;
    manualRecovery.stage='manual';manualRecovery.feedback=true;
    log('已收到用户操作，取消本次自动刷新'); save();
  }
  function completeManualRecovery(reason) {
    if (!manualRecovery || manualRecovery.stage==='manual') return;
    clearTimeout(manualTimer);manualTimer=null;
    manualRecovery.stage='manual';
    setPhase('manual',reason);log(reason);save();
    request({type:'assistant:attention',reason});
  }
  async function pollManualRecovery() {
    const job=manualRecovery;
    if (!job || manualBusy || pageHidden) return;
    if (job.course!==courseKey() || job.scope!==scopeKey() || job.resource!==(new URL(location.href).searchParams.get('resource_id') || '')) {
      clearManualRecovery();control('stop');return;
    }
    if (job.stage==='waiting' && Date.now()>=job.dueAt) {
      manualBusy=true;
      const result=await request({type:'assistant:recover-now',jobId:job.id});
      if (manualRecovery!==job) return;
      manualBusy=false;
      if (result?.ok && result.job) {
        manualRecovery=result.job;manualBaseline=null;
        setPhase('ready','已刷新，正在核验自动恢复');scheduleManualRecovery();
      } else completeManualRecovery('未能执行自动刷新，请手动处理。');
      return;
    }
    if (job.stage==='checking' || job.stage==='waiting' || job.stage==='manual') {
      // An event alone is insufficient: verify the media clock advances.
      const blocked=candidates().length>0;
      if (!blocked && currentRow() && video && !video.error && !video.ended && video.readyState>=2) {
        if (manualBaseline==null) manualBaseline=video.currentTime;
        if (!video.paused && video.currentTime>manualBaseline+.5) {
          clearManualRecovery();setPhase('playing');log('已确认播放恢复，取消自动刷新和人工提醒');save();
          request({type:'assistant:clear-attention'});maybeAdvance();return;
        }
        if (job.stage==='checking' && video.paused && !manualPlayAttempted) {
          manualPlayAttempted=true;tryPlay(generation);
        }
      }
      if (job.stage==='checking' && Date.now()>=job.checkUntil) {
        completeManualRecovery('自动刷新后仍未恢复播放，请在网页中手动处理，再点击“已处理，继续”。');return;
      }
    }
    scheduleManualRecovery();render();
  }
  function attention(reason, refresh=true) {
    const fresh=state.phase!=='manual';
    clearNetwork();
    if (fresh) {cancelPending();setPhase('manual',reason);log(reason);}
    if (refresh) startManualRecovery(reason);
    else clearManualRecovery();
    save();
    if (fresh && manualRecovery?.stage!=='checking') request({type:'assistant:attention',reason:manualRecovery?.stage==='waiting' ? reason+' 2分钟未操作将自动刷新一次。' : reason});
  }
  function fail(reason, refresh=true) {
    clearNetwork();cancelPending();
    startManualRecovery(reason,refresh);
    state.enabled=false;setPhase('error',reason);log(reason);save();
    request({type:'assistant:attention',reason:manualRecovery?.stage==='waiting' ? reason+' 2分钟未操作将自动刷新一次。' : reason});
  }
  function snapshot() {
    const progress = progressSnapshot();
    const mediaPlaying = !!video?.isConnected && !video.paused && !video.ended && !video.error && video.readyState >= 2;
    const traffic = Core.trafficState({...state, mediaPlaying, wakeActive, nativeActive});
    const due = networkJob?.inFlight ? networkJob.checkUntil : networkJob?.nextAttemptAt;
    const retryText = manualRecovery && manualRecovery.stage!=='manual' ? `${manualRecovery.stage==='waiting' ? '无人操作后自动刷新一次' : '已刷新一次 · 正在核验播放'} ${timeText(Math.max(0,((manualRecovery.stage==='waiting'?manualRecovery.dueAt:manualRecovery.checkUntil)-Date.now())/1000))}` : networkJob ? `${networkJob.attempts}/3 次已尝试 · ${networkJob.inFlight ? '正在核验播放' : '下次重试'} ${timeText(Math.max(0, (due-Date.now())/1000))}` : '';
    return {enabled: state.enabled, autoConfirm: state.autoConfirm, autoNextCourse: state.autoNextCourse, keepAwake: state.keepAwake, collapsed: state.collapsed, wakeActive, nativeActive, nativeStatus, awakeText: awakeText(), phase: state.phase,
      status: `${label[state.phase]}${state.reason ? '：' + state.reason : ''}`,
      episode: title(currentRow()), logs: state.logs.slice(), videoFound: !!video, episodeCount: rows().length,
      mediaPlaying, traffic, retryText, progress, progressText: progressText(progress)};
  }
  function clearNetwork() {
    clearTimeout(networkTimer); networkTimer = null;
    networkJob = null; networkBusy = false; recoveryBaseline = null; recoveryPlaying = false;
  }
  function isNetworkError() {
    const errorText = video?.closest('.xgplayer')?.querySelector('.xgplayer-error, xg-error')?.textContent;
    return Core.networkError(video?.error?.code, navigator.onLine, errorText);
  }
  function beginNetwork() {
    if (!state.enabled || state.phase === 'manual') return;
    if (networkJob) {render(); return;}
    clearManualRecovery();
    cancelPending();
    course = courseKey();
    networkJob = {id:crypto.randomUUID(), course, scope:scopeKey(), resource:new URL(location.href).searchParams.get('resource_id') || '',
      title:title(currentRow()), startedAt:Date.now(), attempts:0, nextAttemptAt:Date.now()+retryInterval, inFlight:false, checkUntil:0};
    setPhase('network', '每 2 分钟重试一次，最多 3 次');
    log('检测到网络错误，开始固定重试计划'); save(); scheduleNetwork();
  }
  function scheduleNetwork() {
    clearTimeout(networkTimer);
    if (!networkJob) return;
    const due = networkJob.inFlight ? Math.min(networkJob.checkUntil, Date.now()+1000) : networkJob.nextAttemptAt;
    networkTimer = setTimeout(() => {networkTimer=null; pollNetwork();}, Math.max(0, due-Date.now()));
  }
  async function finishNetwork() {
    const job=networkJob;
    if (!job || !state.enabled) return;
    try {video?.pause();} catch {}
    clearNetwork(); cancelPending(); state.enabled=false;
    setPhase('error', '网络重试 3 次仍未恢复，已停止播放');
    log('网络重试结束，释放唤醒并请求锁屏');
    await save();
    const result=await request({type:'assistant:network-exhausted',jobId:job.id,startedAt:job.startedAt,attempts:job.attempts,documentToken});
    const detail=result?.locked ? 'Mac 已锁屏' : result?.reason === 'other-playback' ? '其他标签仍在播放，暂不锁屏' : result?.reason === 'system-idle' ? '已释放保护，等待系统按现有设置锁屏' : '未能确认锁屏，请检查本地组件或权限';
    state.reason += `；${detail}`; log(detail); render();
    request({type:'assistant:attention',reason:state.reason});
  }
  async function pollNetwork() {
    if (!networkJob || networkBusy || !state.enabled || pageHidden) return;
    const job=networkJob;
    if (job.course !== courseKey() || job.scope !== scopeKey() || job.resource !== (new URL(location.href).searchParams.get('resource_id') || '')) {
      clearNetwork(); control('stop'); return;
    }
    bindVideo();
    if (inspectPrompts()) {if (networkJob) scheduleNetwork(); return;}
    if (video && !video.error && video.readyState >= 2 && !video.ended) {
      if (recoveryBaseline == null) recoveryBaseline = video.currentTime;
      if (!video.paused && video.currentTime > recoveryBaseline + .5) {
        clearNetwork(); setPhase('playing'); log('已确认视频时间前进，网络恢复，取消剩余重试'); save(); maybeAdvance(); return;
      }
      if (job.inFlight && video.paused && !recoveryPlaying) {
        recoveryPlaying=true;
        Promise.resolve().then(()=>video?.play()).catch(error=>{
          if (networkJob!==job) return;
          if (error?.name==='NotAllowedError') {attention('浏览器阻止自动播放，请点击网页播放按钮。');}
        }).finally(()=>{recoveryPlaying=false;});
      }
    }
    if (job.inFlight && Date.now() >= job.checkUntil) {
      if (job.attempts >= 3) {await finishNetwork(); return;}
      job.inFlight=false; recoveryBaseline=null;
      job.nextAttemptAt=job.startedAt+(job.attempts+1)*retryInterval;
      save();
    }
    if (!job.inFlight && Date.now() >= job.nextAttemptAt) {
      networkBusy=true;
      job.attempts++;
      job.inFlight=true;
      job.checkUntil=Date.now()+retryGrace;
      // Persist before reload so refresh cannot reset the retry count/window.
      const stored=await save();
      if (networkJob!==job || !state.enabled) {networkBusy=false; return;}
      if (!stored?.ok) {networkBusy=false; attention('无法保存网络重试计划，请重新加载扩展。'); return;}
      log(`网络重试 ${job.attempts}/3：重新加载当前播放页`);
      location.reload();
      return;
    }
    render(); scheduleNetwork();
  }
  function buildPanel() {
    panel = document.createElement('div');
    panel.id = 'course-assistant-host';
    // Important declarations keep the controls usable under website CSS.
    panel.style.cssText = 'position:fixed!important;right:20px!important;bottom:20px!important;z-index:2147483647!important;display:block!important;width:min(340px,calc(100vw - 40px))!important;height:auto!important;max-height:none!important;overflow:visible!important;background:transparent!important;border:0!important;border-radius:24px!important;padding:0!important;margin:0!important;box-shadow:none!important;outline:0!important;filter:none!important;backdrop-filter:none!important;';
    document.documentElement.append(panel);
    const shadow = panel.attachShadow({mode: 'open'});
    shadow.innerHTML = `<style>${CourseAssistantUI.css}</style>${CourseAssistantUI.markup()}`;
    ui = CourseAssistantUI.bind(shadow);
    ui.toggle.addEventListener('click', () => control(state.enabled ? 'stop' : 'start'));
    ui.resume.addEventListener('click', () => control('resume'));
    ui.confirm.addEventListener('change', () => {state.autoConfirm = ui.confirm.checked; save(); render();});
    ui['next-course'].addEventListener('change', () => control('course-option', ui['next-course'].checked));
    ui['awake-option'].addEventListener('change', () => control('awake-option', ui['awake-option'].checked));
    ui.collapse.addEventListener('click', () => {
      state.collapsed = !state.collapsed;
      save(); render();
    });
    render();
  }
  function render() {
    syncMedia();
    if (!ui) return;
    CourseAssistantUI.render(ui, snapshot());
    ui.body.hidden = state.collapsed;
    ui.shell.dataset.collapsed = String(state.collapsed);
    ui.collapse.textContent = state.collapsed ? '+' : '−';
    ui.collapse.setAttribute('aria-label', state.collapsed ? '展开面板' : '收起面板');
    ui.collapse.setAttribute('aria-expanded', String(!state.collapsed));
  }
  function candidates() {
    const found = [...document.querySelectorAll(MODAL)].filter(visible);
    // Some custom player prompts have no dialog role: require explicit prompt text
    // inside a small positioned overlay. Never inspect the whole course description.
    const player = video?.closest('.xgplayer') || video?.parentElement;
    if (player) {
      for (const node of player.querySelectorAll('div, section')) {
        if (!visible(node) || node.contains(video)) continue;
        const text = Core.normalize(node.textContent);
        if (!text || text.length > 1000 || Core.classifyPrompt(text) === 'unknown') continue;
        const style = getComputedStyle(node);
        if (['absolute', 'fixed'].includes(style.position) && node.querySelector('button, [role="button"], input[type="radio"], input[type="text"]')) found.push(node);
      }
    }
    return [...new Set(found)].filter(node => !found.some(other => other !== node && other.contains(node)));
  }
  function inspectPrompts() {
    if (!state.enabled) return false;
    const prompts = candidates();
    // Any manual/unknown dialog takes priority over a simultaneous continue prompt.
    const classified = prompts.map(node => {
      const text = Core.normalize(node.textContent);
      const inputs = [...node.querySelectorAll('input:not([type="hidden"]):not([type="button"]):not([type="submit"]), textarea, select, [role="radio"]')];
      // This exact site welcome notice has a preference checkbox, not an answer.
      const welcome = text.replace(/\s/g, '') === '温馨提示欢迎进入学习，建议保持当前页面观看视频，若切换窗口会影响您的考核计时～今日不再提示知道了' &&
        inputs.length === 1 && inputs[0].matches('input[type="checkbox"]');
      return {node, text, kind: welcome ? 'notice' : Core.classifyPrompt(text, inputs.length > 0)};
    });
    const blocker = classified.find(item => !['confirm', 'notice'].includes(item.kind));
    if (blocker) {
      if (state.phase !== 'manual') log(`需要人工处理的弹窗：${blocker.text.slice(0, 160)}`);
      attention(blocker.kind === 'manual' ? '检测到答题或验证，请在网页中手动完成。' : '检测到未识别的弹窗，请查看并手动处理。');
      return true;
    }
    for (const {node, kind} of classified) {
      if (!state.autoConfirm) {attention(kind === 'notice' ? '出现网站欢迎提示，请手动确认。' : '出现继续播放提示，请手动确认。'); return true;}
      if (state.phase === 'manual') return true;
      const buttonText = kind === 'notice' ? /^知道了$/ : /^(确定|确认|继续播放|继续观看)$/;
      const buttons = [...node.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]')].filter(button => visible(button) && !button.disabled && button.getAttribute('aria-disabled') !== 'true' && buttonText.test(Core.normalize(button.textContent || button.value)));
      if (buttons.length !== 1) {attention('继续播放提示的按钮无法确定，请手动处理。'); return true;}
      if (confirmed.has(node)) continue;
      const token = generation;
      const operation = {attempts: 0, lastClickAt: -Infinity, expiresAt: Date.now() + 8000};
      confirmed.set(node, operation);
      const check = () => {
        if (!state.enabled || token !== generation || state.phase === 'manual' || confirmed.get(node) !== operation) {confirmed.delete(node); return;}
        // Re-query active overlays: the framework may leave an invisible node
        // mounted, replace it, or show a question after the notice closes.
        const active = candidates();
        if (!active.includes(node)) {
          confirmed.delete(node);
          reconcile();
          tryPlay(token);
          return;
        }
        const currentInputs = [...node.querySelectorAll('input:not([type="hidden"]):not([type="button"]):not([type="submit"]), textarea, select, [role="radio"]')];
        const currentText = Core.normalize(node.textContent);
        const stillNotice = kind === 'notice' && currentText.replace(/\s/g, '') === '温馨提示欢迎进入学习，建议保持当前页面观看视频，若切换窗口会影响您的考核计时～今日不再提示知道了' && currentInputs.length === 1 && currentInputs[0].matches('input[type="checkbox"]');
        if (!(stillNotice || kind === 'confirm' && Core.classifyPrompt(currentText, currentInputs.length > 0) === 'confirm')) {
          confirmed.delete(node); inspectPrompts(); return;
        }
        if (!state.autoConfirm) {confirmed.delete(node); inspectPrompts(); return;}
        if (Date.now() >= operation.expiresAt) {
          confirmed.delete(node); attention('播放提示多次确认后仍未关闭，请检查网站响应。'); return;
        }
        const fresh = [...node.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]')].filter(button => visible(button) && !button.disabled && button.getAttribute('aria-disabled') !== 'true' && buttonText.test(Core.normalize(button.textContent || button.value)));
        if (fresh.length === 1 && operation.attempts < 3 && Date.now() - operation.lastClickAt >= 2000 && fresh[0].getAttribute('aria-busy') !== 'true') {
          operation.attempts++; operation.lastClickAt = Date.now(); fresh[0].click();
          log(kind === 'notice' ? '已确认网站欢迎提示' : '已点击继续播放确认');
        }
        setTimeout(check, 250);
      };
      check();
      return true;
    }
    return prompts.length > 0;
  }
  function bindVideo() {
    const found = [...document.querySelectorAll('video')].filter(visible).sort((a, b) => b.getBoundingClientRect().width * b.getBoundingClientRect().height - a.getBoundingClientRect().width * a.getBoundingClientRect().height);
    const next = found[0] || null;
    if (next === video) return;
    removers.splice(0).forEach(remove => remove());
    video = next;
    videoContext = context();
    if (video) {
      const bound = video;
      const listen = (event, callback) => {bound.addEventListener(event, callback); removers.push(() => bound.removeEventListener(event, callback));};
      for (const event of ['loadstart', 'emptied']) listen(event, () => {mediaCycle++; loadedCycle = -1;});
      listen('loadedmetadata', () => {loadedCycle = mediaCycle;});
      listen('ended', () => {onEnded(bound); render();});
      for (const event of ['loadedmetadata', 'durationchange', 'playing', 'timeupdate', 'emptied']) listen(event, () => {
        if (!bound.ended) videoContext = context();
        if (manualRecovery) pollManualRecovery();
        if (networkJob) {pollNetwork(); render(); return;}
        if (state.enabled && !['manual', 'switching', 'course','network'].includes(state.phase)) setPhase(bound.paused ? 'paused' : 'playing');
        maybeAdvance();
        render();
      });
      for (const event of ['waiting', 'stalled', 'abort']) listen(event, render);
      listen('pause', () => {
        if (state.enabled && !bound.ended && !['manual', 'switching', 'course','network'].includes(state.phase)) setPhase('paused', '可手动播放后继续');
        render();
      });
      listen('error', () => {if (state.enabled) {if (isNetworkError()) beginNetwork(); else attention('播放器报告错误，请检查网络或重新播放。');} render();});
      log('已识别网页播放器');
    }
    render();
  }
  async function tryPlay(token) {
    if (!state.enabled || generation !== token || state.phase === 'manual' || networkJob || pendingCourse || pendingEpisode) return;
    bindVideo();
    if (!video || video.ended) return;
    if (inspectPrompts()) return;
    if (maybeAdvance()) return;
    const playingVideo = video;
    try {
      if (video.paused) await video.play();
      if (state.enabled && generation === token && state.phase !== 'manual' && video === playingVideo && !pendingCourse && !pendingEpisode) {
        if (video.paused) attention('视频尚未开始播放，请点击网页播放按钮。');
        else setPhase('playing');
      }
    } catch {
      if (state.enabled && generation === token && video === playingVideo && !pendingCourse && !pendingEpisode) attention('自动播放未成功，请点击网页播放按钮，再点击“已处理，继续”。');
    }
  }
  async function enterNextCourse(token, entryDeadline = Date.now() + 8000) {
    if (!state.enabled || generation !== token || state.phase === 'manual') return;
    if (!directoryStatus().complete) {attention('目录仍有未完成的集数，请先完成后再继续。'); return;}
    if (!state.autoNextCourse) {finishCourse('目录已全部完成，跨课程播放已关闭'); return;}
    const target = nextCourseTarget();
    if (target.kind === 'missing' && Date.now() < entryDeadline) {
      setPhase('course', '等待下一课程入口加载');
      courseTimer = setTimeout(() => enterNextCourse(token, entryDeadline), 500);
      return;
    }
    if (target.kind === 'missing' || target.kind === 'disabled') {finishCourse('目录已全部完成，没有可用的下一个课程'); return;}
    if (target.kind !== 'ready') {attention('无法确定下一个课程入口，请手动选择。'); return;}
    if (target.expectedCourse && state.visitedCourses.includes(target.expectedCourse)) {attention('下一个课程指向已连续播放过的课程，请手动检查。',false); return;}
    courseOriginVideo = video;
    courseOriginCycle = mediaCycle;
    courseOriginRows = rows();
    pendingCourse = {fromCourse: course, scope: scopeKey(), fromSource: source(), expiresAt: Date.now() + 60000,
      fromDirectoryState: directoryState(courseOriginRows),
      clicked: true, toCourse: null, expectedCourse: target.expectedCourse, attempts: 1, lastClickAt: Date.now()};
    switchJob = null;
    setPhase('course');
    // Save before clicking so a full page navigation can restore the handoff.
    const stored = await save();
    if (!state.enabled || generation !== token || !pendingCourse) return;
    if (stored?.ok !== true) {attention('未能保存跨课程状态，请手动进入下一个课程。'); return;}
    if (inspectPrompts()) return;
    // User or site navigation during the save must never trigger another click.
    if (courseKey() === pendingCourse.fromCourse) {
      const fresh = nextCourseTarget();
      if (fresh.kind !== 'ready' || fresh.expectedCourse !== target.expectedCourse) {attention('下一个课程入口发生变化，请手动检查。'); return;}
      if (!directoryStatus().complete) {attention('目录完成状态发生变化，请先检查。'); return;}
      fresh.element.click();
      log('目录全部完成，已点击下一个课程');
    }
    verifyCourse(token);
  }
  function finishCourse(reason) {
    clearManualRecovery();
    cancelPending();
    state.enabled = false;
    setPhase('last', reason);
    log(reason);
    save();
    request({type: 'assistant:attention', reason});
  }
  function verifyCourse(token) {
    clearTimeout(courseTimer);
    if (!state.enabled || generation !== token || !pendingCourse) return;
    if (!Core.canContinue(pendingCourse, courseKey(), scopeKey(), Date.now()) || !location.pathname.startsWith('/web/player/')) {
      if (courseKey() !== course || scopeKey() !== pendingCourse.scope) {
        course = courseKey();
        fail('下一课程超时或跳转到不符合预期的页面，请手动检查。',false);
        return;
      }
      attention('下一课程跳转超时或页面不符合预期，请手动检查。'); return;
    }
    const destination = courseKey();
    if (destination !== pendingCourse.fromCourse) {
      if (!new URL(location.href).searchParams.get('course_id') ||
          (pendingCourse.expectedCourse && pendingCourse.expectedCourse !== destination) ||
          (state.visitedCourses.includes(destination) && pendingCourse.toCourse !== destination)) {
        course = destination;
        fail('下一个课程不符合预期或发生循环，请手动检查。',false); return;
      }
      if (!pendingCourse.toCourse) {
        pendingCourse.toCourse = destination;
        course = destination;
        state.visitedCourses.push(destination);
        state.visitedCourses = state.visitedCourses.slice(-100);
        handledEnds.clear();
        repeatProgress.clear();
        save();
        log('已进入下一个课程，正在核验播放器');
      }
      if (inspectPrompts()) return;
      bindVideo();
      const listing = rows();
      // Wait for new media, not just the changed course_id and stale DOM.
      if (video && source() && (source() !== pendingCourse.fromSource ||
          (courseOriginVideo && video !== courseOriginVideo) ||
          (mediaCycle > courseOriginCycle && loadedCycle === mediaCycle)) &&
          video.readyState >= 2 && !video.ended && listing.length &&
          freshCourseDirectory(listing) && !!currentRow()) {
        pendingCourse = null;
        switchJob = null;
        videoContext = context();
        save();
        log('已核验新课程目录和视频加载');
        tryPlay(token);
        return;
      }
    }
    if (inspectPrompts()) return;
    // Retry only while still on the original course and no new media arrived.
    // Once navigation is observed, never click the next-course button again.
    if (destination === pendingCourse.fromCourse && source() === pendingCourse.fromSource && mediaCycle === courseOriginCycle &&
        (pendingCourse.attempts || 1) < 3 && Date.now() - (pendingCourse.lastClickAt || 0) >= 8000) {
      const target = nextCourseTarget();
      if (target.kind === 'ready' && target.expectedCourse === pendingCourse.expectedCourse &&
          directoryStatus().complete && target.element.getAttribute('aria-busy') !== 'true') {
        pendingCourse.attempts = (pendingCourse.attempts || 1) + 1;
        pendingCourse.lastClickAt = Date.now();
        save();
        target.element.click();
        log(`下一课程尚未响应，重试 ${pendingCourse?.attempts || 3}/3`);
      }
    }
    courseTimer = setTimeout(() => verifyCourse(token), 500);
  }
  function maybeAdvance() {
    if (!state.enabled || state.phase === 'manual' || networkJob || pendingCourse || switchJob || courseKey() !== course) return false;
    const listing = rows();
    if (!listing.length || !currentRow()) return false;
    if (directoryStatus().complete || (rowProgress(currentRow()).complete && video && source() && video.readyState >= 2 && videoContext === context())) {
      queueAdvance(false);
      return true;
    }
    return false;
  }
  function onEnded(bound, resumed = false) {
    if (!state.enabled || bound !== video || !bound.ended || networkJob || state.phase === 'manual' || switchJob || pendingCourse) return;
    const origin = videoContext;
    if (!origin || context() !== origin || (handledEnds.has(origin) && !resumed)) return;
    if (inspectPrompts()) return;
    handledEnds.add(origin);
    if (handledEnds.size > 60) handledEnds.delete(handledEnds.values().next().value);
    queueAdvance(true);
  }
  function queueAdvance(ended) {
    if (inspectPrompts()) return;
    const token = generation;
    const origin = context();
    switchJob = {origin};
    setPhase('switching');
    // Let the site's own next-episode handler finish, then inspect fresh rows.
    timer = setTimeout(() => {
      if (!state.enabled || generation !== token || !switchJob) return;
      if (courseKey() !== course) {cancelPending(); return;}
      if (inspectPrompts()) return;
      if (directoryStatus().complete) {enterNextCourse(token); return;}
      const listing = rows();
      const current = listing.indexOf(currentRow());
      if (current < 0) {fail('无法确定当前视频，请检查目录。'); return;}
      if (context() !== origin && !rowProgress(listing[current]).complete) {
        switchJob = null;
        log('网站已自行切集，助手未重复点击');
        setPhase(video?.paused ? 'paused' : 'playing');
        return;
      }
      const forward = listing.findIndex((row, index) => index > current && !rowProgress(row).complete);
      const earlier = listing.findIndex((row, index) => index < current && !rowProgress(row).complete);
      const target = forward >= 0 ? forward : earlier;
      if (target >= 0) {switchEpisode(listing[target], token, target < current); return;}
      // Only this episode remains incomplete. Allow its server mark to arrive.
      if (ended && !rowProgress(listing[current]).complete) {
        const deadline = Date.now() + 20000;
        const waitCompletion = () => {
          if (!state.enabled || generation !== token || !switchJob) return;
          if (inspectPrompts()) return;
          if (courseKey() !== course || context() !== origin) {cancelPending(); return;}
          if (directoryStatus().complete) {enterNextCourse(token); return;}
          if (Date.now() >= deadline) {switchEpisode(currentRow(), token, true, true); return;}
          timer = setTimeout(waitCompletion, 500);
        };
        waitCompletion();
      } else {switchJob = null; setPhase(video?.paused ? 'paused' : 'playing');}
    }, 1600);
  }
  async function switchEpisode(target, token, repair = false, replay = false) {
    if (!state.enabled || generation !== token || !switchJob) return;
    if (!target?.isConnected || !rows().includes(target)) {fail('目录发生变化，请手动检查。'); return;}
    if (rowProgress(target).complete) {switchJob = null; maybeAdvance(); return;}
    const nextTitle = title(target);
    if (rows().filter(row => title(row) === nextTitle).length !== 1) {attention('目录标题重复，无法确定目标集。'); return;}
    if (repair) {
      const progress = rowProgress(target).percent;
      const previous = repeatProgress.get(nextTitle);
      const stalled = previous && (progress == null || previous.percent == null || progress <= previous.percent) ? previous.stalled + 1 : 0;
      if (stalled >= 3) {attention(`补播后目录进度连续未更新，请检查网站记录：${nextTitle}`); return;}
      repeatProgress.set(nextTitle, {percent: progress, stalled});
      handledEnds.delete(context());
    }
    pendingEpisode = {fromCourse: course, scope: scopeKey(), fromSource: source(), fromTitle: title(currentRow()),
      fromResource: new URL(location.href).searchParams.get('resource_id') || '', nextTitle,
      replay, expiresAt: Date.now() + 45000, attempts: 1, lastClickAt: Date.now()};
    switchJob = {origin: context(), nextTitle, originVideo: video, originCycle: mediaCycle};
    const stored = await save();
    if (!state.enabled || generation !== token || !pendingEpisode) return;
    if (stored?.ok !== true) {attention('未能保存切集状态，请手动选择下一集。'); return;}
    if (inspectPrompts()) return;
    const fresh = rows().filter(row => title(row) === nextTitle);
    if (fresh.length !== 1) {attention('目标目录发生变化，请手动检查。'); return;}
    fresh[0].click();
    log(`${repair ? '自动补播未完成集' : '已选择未完成集'}：${nextTitle}`);
    timer = setTimeout(() => verifyEpisode(token), 500);
  }
  function verifyEpisode(token) {
    clearTimeout(timer);
    if (!state.enabled || generation !== token || !pendingEpisode || !switchJob) return;
    const job = pendingEpisode;
    if (job.fromCourse !== courseKey() || job.scope !== scopeKey()) {control('stop'); return;}
    if (Date.now() >= job.expiresAt) {attention('目标视频加载超时，请检查网络后点击“已处理，继续”。'); return;}
    if (inspectPrompts()) return;
    bindVideo();
    const listing = rows();
    const selected = title(currentRow());
    if (selected && selected !== job.nextTitle && selected !== job.fromTitle) {
      cancelPending(); setPhase(video?.paused ? 'paused' : 'playing'); log('你或网站选择了其他集，已取消本次切集'); return;
    }
    const changedMedia = source() !== job.fromSource || video !== switchJob.originVideo ||
      (mediaCycle > switchJob.originCycle && loadedCycle === mediaCycle);
    const replayReady = job.replay && video && !video.ended && (changedMedia || video.currentTime < video.duration - 1);
    if (selected === job.nextTitle && !!currentRow() &&
        video && source() && video.readyState >= 2 && !video.ended && (changedMedia || replayReady)) {
      pendingEpisode = null; switchJob = null;
      videoContext = context(); handledEnds.delete(videoContext); save();
      log('已核验目标集视频加载');
      setPhase(video.paused ? 'ready' : 'playing');
      tryPlay(token);
      return;
    }
    if (job.attempts < 3 && Date.now() - job.lastClickAt >= 8000 && !changedMedia && mediaCycle === switchJob.originCycle) {
      const target = listing.filter(row => title(row) === job.nextTitle);
      if (target.length === 1 && !rowProgress(target[0]).complete && target[0].getAttribute('aria-busy') !== 'true') {
        job.attempts++; job.lastClickAt = Date.now(); save(); target[0].click();
        log(`目标视频尚未加载，重试 ${job.attempts}/3`);
      }
    }
    timer = setTimeout(() => verifyEpisode(token), 500);
  }
  function control(action, option) {
    if (action === 'start') {
      clearManualRecovery();
      clearNetwork();
      cancelPending();
      state.enabled = true;
      course = courseKey();
      state.visitedCourses = [course];
      handledEnds.clear();
      repeatProgress.clear();
      bindVideo();
      videoContext = context();
      setPhase(video ? (video.paused ? 'paused' : 'playing') : 'ready');
      log('已启用当前课程的连续播放');
      save();
      request({type: 'assistant:clear-attention'});
      if (!inspectPrompts()) {if (isNetworkError()) beginNetwork(); else if (!maybeAdvance() && video?.ended) onEnded(video, true);}
    } else if (action === 'stop') {
      clearManualRecovery();
      clearNetwork();
      cancelPending();
      state.enabled = false;
      setPhase('idle');
      log('已停止助手');
      save();
      request({type: 'assistant:clear-attention'});
    } else if (action === 'resume' && state.enabled) {
      clearManualRecovery();
      clearNetwork();
      cancelPending();
      setPhase('ready');
      request({type: 'assistant:clear-attention'});
      if (!inspectPrompts()) {
        log('用户确认已处理，恢复连续播放');
        if (!maybeAdvance()) {
          if (video?.ended) onEnded(video, true);
          else tryPlay(generation);
        }
      }
    } else if (action === 'option') {
      state.autoConfirm = !!option;
      save();
    } else if (action === 'awake-option') {
      state.keepAwake = !!option;
      save();
    } else if (action === 'course-option') {
      state.autoNextCourse = !!option;
      if (!state.autoNextCourse && pendingCourse) {cancelPending(); setPhase('paused', '已取消跨课程播放');}
      save();
    }
    render();
    return snapshot();
  }
  function reconcile() {
    if (manualRecovery) pollManualRecovery();
    if (networkJob) {pollNetwork(); bindVideo(); render(); return;}
    if (pendingEpisode) {
      verifyEpisode(generation);
    } else if (pendingCourse) {
      verifyCourse(generation);
    } else if (courseKey() !== course || !location.pathname.startsWith('/web/player/')) {
      if (state.enabled) control('stop');
      course = courseKey();
      handledEnds.clear();
    }
    bindVideo();
    if (state.enabled && state.phase !== 'manual' && isNetworkError()) beginNetwork();
    if (state.enabled && !networkJob && !inspectPrompts()) maybeAdvance();
    render();
  }
  async function boot() {
    const stored = await request({type: 'assistant:get-session'});
    state.autoConfirm = stored.autoConfirm !== false;
    state.autoNextCourse = stored.autoNextCourse !== false;
    state.keepAwake = stored.keepAwake !== false;
    state.collapsed = stored.collapsed === true;
    state.visitedCourses = stored.visitedCourses || [course];
    const continuation = stored.enabled === true && state.autoNextCourse && Core.canContinue(stored.pendingCourse, course, scopeKey(), Date.now());
    state.enabled = stored.enabled === true && (stored.course === course || continuation);
    if (continuation) {pendingCourse = stored.pendingCourse; state.phase = 'course';}
    if (state.enabled && !continuation) state.phase = 'ready';
    if (state.enabled && stored.pendingEpisode?.fromCourse === course &&
        Core.canContinue(stored.pendingEpisode, course, scopeKey(), Date.now()) &&
        typeof stored.pendingEpisode.nextTitle === 'string') {
      pendingEpisode = stored.pendingEpisode;
      switchJob = {originVideo: null, originCycle: mediaCycle, nextTitle: pendingEpisode.nextTitle};
      state.phase = 'switching';
    }
    const recovery=stored.manualRecovery;
    if (recovery && recovery.course===course && recovery.scope===scopeKey() &&
        recovery.resource===(new URL(location.href).searchParams.get('resource_id') || '') &&
        ['waiting','checking','manual'].includes(recovery.stage) && Number.isFinite(recovery.dueAt)) {
      manualRecovery=recovery;
      state.enabled=true;
      state.phase=recovery.stage==='checking'?'ready':'manual';
      state.reason=recovery.stage==='checking'?'正在核验自动恢复':recovery.reason;
    }
    const retry=stored.networkJob;
    if (state.enabled && retry?.course===course && retry.scope===scopeKey() &&
        retry.resource===(new URL(location.href).searchParams.get('resource_id') || '') &&
        Number.isFinite(retry.startedAt) && retry.startedAt<=Date.now() && Number.isInteger(retry.attempts) && retry.attempts>=0 && retry.attempts<=3) {
      networkJob=retry; state.phase='network'; state.reason='每 2 分钟重试一次，最多 3 次';
    }
    const style = document.createElement('style');
    style.id = 'course-assistant-player-style';
    style.textContent = '.xgplayer[data-course-assistant-playing="true"] > xg-start.xgplayer-start{display:none!important;pointer-events:none!important}';
    document.documentElement.append(style);
    window.addEventListener('pagehide', () => {pageHidden = true; render();});
    window.addEventListener('pageshow', () => {pageHidden = false; reconcile();});
    for (const name of ['pointerdown','keydown','input']) document.addEventListener(name,event=>{
      if (event.isTrusted) manualFeedback();
    },true);
    buildPanel();
    reconcile();
    scheduleManualRecovery();
    chrome.runtime.onMessage.addListener((message, _sender, respond) => {
      if (message.type === 'assistant:recovery-tick') {pollManualRecovery();respond({ok:true});return;}
      if (message.type === 'assistant:recovery-feedback') {manualFeedback();respond({ok:true});return;}
      if (message.type === 'assistant:network-tick') {pollNetwork(); respond({ok:true}); return;}
      if (message.type === 'assistant:power-probe') {respond({requested: wantsAwake(), documentToken}); return;}
      if (message.type === 'assistant:control') respond(control(message.action, message.action === 'awake-option' ? message.keepAwake : message.action === 'course-option' ? message.autoNextCourse : message.autoConfirm));
    });
    new MutationObserver(() => {
      if (observerTimer) return;
      observerTimer = setTimeout(() => {observerTimer = null; reconcile();}, 250);
    }).observe(document.body, {childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['data-checked', 'style', 'class', 'src']});
    // Low-frequency fallback covers SPA URL changes and delayed player mounts.
    setInterval(reconcile, 1500);
  }
  boot().catch(() => { if (ui) fail('扩展初始化失败，请刷新页面。'); });
})();
