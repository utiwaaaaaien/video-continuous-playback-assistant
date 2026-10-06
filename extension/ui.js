(() => {
  'use strict';
  const css = `
    :host,body{color-scheme:light dark;--radius-shell:24px;--radius-control:12px;--radius-group:16px;--ink:#172331;--muted:#596779;--glass:rgba(244,247,251,.92);--cell:rgba(255,255,255,.72);--edge:rgba(255,255,255,.86);--line:rgba(32,48,67,.10);--accent:#0069db;--track:rgba(26,47,75,.10);--green:#1b794d;--amber:#995500;font:13px/1.5 -apple-system,BlinkMacSystemFont,'SF Pro Text','PingFang SC',sans-serif;color:var(--ink);text-align:left;-webkit-font-smoothing:antialiased}
    *{box-sizing:border-box}button,input{font:inherit}button{cursor:pointer}button:disabled{opacity:.45;cursor:default}
    .shell{position:relative;isolation:isolate;background:var(--glass);background-clip:padding-box;backdrop-filter:blur(30px) saturate(145%);-webkit-backdrop-filter:blur(30px) saturate(145%);border:1px solid var(--edge);border-radius:var(--radius-shell);box-shadow:0 16px 48px #14243826,0 2px 8px #14243812,inset 0 0 0 1px var(--line);max-height:calc(100vh - 40px);max-height:calc(100dvh - 40px);overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:var(--track) transparent}
    header{display:flex;align-items:center;gap:10px;padding:16px 16px 12px}.app-icon{width:32px;height:32px;flex-shrink:0;border-radius:10px;background:linear-gradient(155deg,#6bbbff,#0b71e9);border:1px solid #ffffff7a;box-shadow:inset 0 1px 1px #ffffff6b;display:grid;place-items:center;color:white}.app-icon svg{width:18px;height:18px}
    .heading{flex:1;min-width:0}h1{display:flex;align-items:baseline;gap:4px;margin:0;font-size:14px;line-height:1.4;font-weight:600;letter-spacing:-.3px}.app-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.subtitle{color:var(--muted);font-size:10px;letter-spacing:.2px;margin-top:1px}.version{font-size:10px;font-weight:500;color:var(--muted);flex-shrink:0;white-space:nowrap}
    .header-controls{display:flex;align-items:center;gap:8px;flex-shrink:0}.icon-button{border:1px solid var(--line);background:var(--cell);color:var(--muted);border-radius:50%;width:28px;height:28px;padding:0;display:grid;place-items:center;font-size:18px;line-height:1}
    .overview{padding:0 16px 14px}.state-row{display:flex;align-items:center;gap:7px;margin:2px 0 8px}.status{font-size:11px;font-weight:600;flex:1;overflow-wrap:anywhere}.status[data-wait=true]{color:var(--amber)}
    .traffic{display:flex;align-items:center;margin:0}.traffic-lights{display:flex;gap:5px;padding:5px 7px;border-radius:999px;background:var(--track);border:1px solid var(--line)}.bulb{width:10px;height:10px;border-radius:50%;background:var(--muted);opacity:.18;box-shadow:inset 0 1px 2px #0002}.traffic[data-color=red] .bulb-red{background:#f04445;opacity:1;box-shadow:0 0 0 2px #f044451a}.traffic[data-color=yellow] .bulb-yellow{background:#edaa18;opacity:1;box-shadow:0 0 0 2px #edaa181a}.traffic[data-color=green] .bulb-green{background:#27b86a;opacity:1;box-shadow:0 0 0 2px #27b86a1a}.retry{font-size:10px;color:var(--amber);margin:0 0 8px;font-variant-numeric:tabular-nums}
    .episode{font-size:12px;line-height:1.6;color:var(--ink);margin:0 0 10px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
    .time-row{display:flex;align-items:baseline;justify-content:space-between;font-variant-numeric:tabular-nums;gap:8px}.time{font-size:12px;font-weight:600;letter-spacing:.1px}.percentage{font-size:11px;color:var(--muted)}
    progress{appearance:none;-webkit-appearance:none;width:100%;height:5px;display:block;margin:7px 0 8px;border:0;border-radius:5px;background:var(--track);overflow:hidden}progress::-webkit-progress-bar{background:var(--track);border-radius:5px}progress::-webkit-progress-value{background:var(--accent);border-radius:5px;transition:width .25s ease}progress::-moz-progress-bar{background:var(--accent)}
    .directory-row{display:flex;justify-content:space-between;gap:8px;color:var(--muted);font-size:10px;font-variant-numeric:tabular-nums}.awake{color:var(--muted);font-size:10px;line-height:1.5;margin:10px 0 0;display:flex;gap:6px;align-items:flex-start}.awake::before{content:'◉';color:var(--muted)}.awake[data-active=true]::before{color:var(--green)}
    .body{border-top:1px solid var(--line);padding:14px 16px 16px}.actions{display:flex;gap:8px;margin-bottom:14px}.primary,.secondary{border:0;border-radius:var(--radius-control);padding:10px 12px;font-weight:600;font-size:12px;flex:1;min-width:0}.primary{background:var(--accent);color:#fff;box-shadow:inset 0 1px 0 #ffffff26,0 2px 4px #005cba15}.secondary{background:var(--cell);border:1px solid var(--line);color:var(--ink)}
    .settings{background:var(--cell);border:1px solid var(--line);border-radius:var(--radius-group);padding:0 12px}.setting{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:11px 0;margin:0;font-size:11px;line-height:1.4}.setting+.setting{border-top:1px solid var(--line)}.setting input{appearance:none;-webkit-appearance:none;width:30px;height:18px;flex-shrink:0;border-radius:999px;background:var(--track);border:1px solid var(--line);position:relative;margin:0;cursor:pointer;transition:background .15s}.setting input::after{content:'';position:absolute;left:1px;top:1px;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 3px #0003;transition:transform .15s}.setting input:checked{background:var(--accent);border-color:transparent}.setting input:checked::after{transform:translateX(12px)}
    .hint{font-size:10px;line-height:1.65;color:var(--muted);margin:12px 0 0}details{margin-top:12px;font-size:10px;color:var(--muted)}summary{cursor:pointer;padding:3px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:10px/1.65 ui-monospace,'SF Mono',monospace;max-height:130px;overflow:auto;margin:8px 0 0;color:var(--muted)}
    button:focus-visible,input:focus-visible,summary:focus-visible{outline:3px solid #62aaff;outline-offset:3px}[hidden]{display:none!important}.shell[data-collapsed=true] header{padding-bottom:9px}.shell[data-collapsed=true] .episode{-webkit-line-clamp:1;margin-bottom:7px}.shell[data-collapsed=true] .overview{padding-bottom:13px}.shell[data-collapsed=true] .awake{margin-top:7px}
    @media(prefers-color-scheme:dark){:host,body{--ink:#f0f3f7;--muted:#aebac9;--glass:rgba(31,36,44,.94);--cell:rgba(255,255,255,.065);--edge:rgba(255,255,255,.17);--line:rgba(255,255,255,.10);--accent:#318cff;--track:rgba(225,235,250,.15);--green:#61d095;--amber:#ffca70}.shell{box-shadow:0 18px 50px #0005,inset 0 0 0 1px #0002}}
    @media(prefers-reduced-transparency:reduce){:host,body{--glass:#f0f3f8;--cell:#fff}.shell{backdrop-filter:none;-webkit-backdrop-filter:none}@media(prefers-color-scheme:dark){:host,body{--glass:#242a33;--cell:#303743}}}
    @media(prefers-reduced-motion:reduce){*,*::after{transition:none!important;animation:none!important}}
  `;
  function markup(popup = false) {
    return `<section class="shell" id="shell"><header><div class="app-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><rect x="2" y="4" width="20" height="16" rx="4" stroke="currentColor" stroke-width="1.6"/><path d="m10 8 6 4-6 4z" fill="currentColor"/></svg></div><div class="heading"><h1><span class="app-title">视频连续播放助手</span><span class="version">V3.1</span></h1><div class="subtitle">连续播放 · 自动续集</div></div><div class="header-controls"><div class="traffic" id="traffic" role="status" data-color="red" aria-label="红灯：未播放"><span class="traffic-lights" aria-hidden="true"><i class="bulb bulb-red"></i><i class="bulb bulb-yellow"></i><i class="bulb bulb-green"></i></span></div><button class="icon-button" id="collapse" aria-label="收起面板" aria-expanded="true" ${popup ? 'hidden' : ''}>−</button></div></header>
    <div class="overview"><p id="retry" class="retry" hidden></p><div class="state-row"><div id="status" class="status" role="status" aria-live="polite">正在连接播放页…</div></div><p id="episode" class="episode">正在读取当前视频</p><div class="time-row"><span id="time" class="time">--:-- / --:--</span><span id="percentage" class="percentage">--%</span></div><progress id="timeline" max="100" value="0" aria-label="当前视频播放进度"></progress><div class="directory-row"><span id="directory">目录进度：待识别</span><span id="completion">已完成 0/0 集</span></div><div id="awake" class="awake">保持唤醒：等待播放</div></div>
    <div class="body" id="body"><div class="actions"><button class="primary" id="toggle">开始连续播放</button><button class="secondary" id="resume" hidden>已处理，继续</button></div><div class="settings"><label class="setting"><span>自动确认播放提示</span><input id="confirm" type="checkbox" role="switch"></label><label class="setting"><span>播放时保持 Mac 唤醒</span><input id="awake-option" type="checkbox" role="switch"></label><label class="setting"><span>目录完成后进入下一课程</span><input id="next-course" type="checkbox" role="switch"></label></div><p class="hint">自动跳过已完成视频，并补播遗漏。遇到题目时会暂停自动操作，等待你完成。</p><details><summary>操作记录与诊断</summary><pre id="diagnostic"></pre><pre id="logs">暂无记录</pre></details></div></section>`;
  }
  const ids = ['traffic','retry','shell','body','status','episode','time','percentage','timeline','directory','completion','awake','toggle','resume','confirm','awake-option','next-course','collapse','diagnostic','logs'];
  const bind = root => Object.fromEntries(ids.map(id => [id, root.querySelector(`#${id}`)]));
  const time = value => value == null ? '--:--' : `${Math.floor(value / 60).toString().padStart(2,'0')}:${Math.floor(value % 60).toString().padStart(2,'0')}`;
  function render(ui, data) {
    const p = data.progress || {};
    const traffic = data.traffic || {color:'red',text:'未播放'};
    const name = {green:'绿灯',yellow:'黄灯',red:'红灯'}[traffic.color];
    ui.traffic.dataset.color = traffic.color;
    ui.traffic.setAttribute('aria-label', `${name}：${traffic.text}`);
    ui.retry.hidden = !data.retryText;
    ui.retry.textContent = data.retryText || '';
    ui.status.textContent = data.status;
    ui.status.dataset.wait = String(['manual','error'].includes(data.phase));
    ui.episode.textContent = data.episode || '等待识别目录';
    ui.episode.title = data.episode || '';
    ui.time.textContent = `${time(p.currentTime)} / ${time(p.duration)}`;
    ui.percentage.textContent = p.playbackPercent == null ? '--%' : `${p.playbackPercent.toFixed(1)}%`;
    ui.timeline.value = p.playbackPercent || 0;
    ui.directory.textContent = `目录进度：${p.directoryComplete ? '完成' : p.directoryPercent == null ? '待识别' : `${p.directoryPercent}%`}`;
    ui.completion.textContent = `已完成 ${p.completedCount || 0}/${p.episodeCount || 0} 集`;
    ui.awake.textContent = data.awakeText || '保持唤醒：等待播放';
    ui.awake.dataset.active = String(!!data.wakeActive);
    ui.toggle.textContent = data.enabled ? '停止连续播放' : '开始连续播放';
    ui.resume.hidden = data.phase !== 'manual';
    ui.confirm.checked = data.autoConfirm;
    ui['awake-option'].checked = data.keepAwake;
    ui['next-course'].checked = data.autoNextCourse;
    ui.logs.textContent = (data.logs || []).join('\n') || '暂无操作记录';
    ui.diagnostic.textContent = `视频：${data.videoFound ? '已识别' : '等待加载'} · 目录：${data.episodeCount || 0} 集`;
  }
  globalThis.CourseAssistantUI = Object.freeze({css, markup, bind, render});
})();
