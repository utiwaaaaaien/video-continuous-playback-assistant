(function (root) {
  'use strict';
  const normalize = text => String(text || '').replace(/\s+/g, ' ').trim();
  function directoryProgress(text) {
    const value = normalize(text);
    const complete = /^(已完成|完成)$/.test(value);
    const match = value.match(/^(\d+(?:\.\d+)?)%/);
    const percent = match && Number(match[1]) <= 100 ? Number(match[1]) : null;
    return {complete, percent: complete ? 100 : percent, text: value};
  }
  function classifyPrompt(text, hasAnswerInputs = false) {
    const value = normalize(text);
    if (hasAnswerInputs || /单选题|多选题|判断题|答题|作答|提交答案|请.{0,12}回答|请选择.{0,12}(答案|选项)|验证码|验证身份|人脸识别/.test(value)) return 'manual';
    if (/(点击|请|是否|确定|确认).{0,30}(继续播放|继续观看)|(继续播放|继续观看).{0,30}(点击|确定|确认)/.test(value)) return 'confirm';
    return 'unknown';
  }
  function selectNext(rows) {
    const selected = rows.map((row, index) => row.checked ? index : -1).filter(index => index >= 0);
    if (selected.length !== 1) return {kind: 'ambiguous'};
    const index = selected[0];
    return index + 1 < rows.length ? {kind: 'next', index: index + 1} : {kind: 'last'};
  }
  function canContinue(pending, course, scope, now) {
    return !!pending && typeof pending.fromCourse === 'string' && pending.scope === scope &&
      Number.isFinite(pending.expiresAt) && pending.expiresAt > now && pending.expiresAt <= now + 65000 &&
      (!pending.toCourse || pending.toCourse === course);
  }
  function networkError(code, online, message) {
    return code === 2 || (code != null && online === false) ||
      /网络错误|网络异常|网络连接失败|连接超时|network error|network failed/i.test(normalize(message));
  }
  function trafficState(data) {
    if (!data.enabled || !data.mediaPlaying || ['manual','error','last','idle','network'].includes(data.phase)) return {color:'red', text:'未播放'};
    const missing=[];
    if (!data.autoConfirm) missing.push('自动确认关闭');
    if (!data.autoNextCourse) missing.push('跨课程关闭');
    if (!data.keepAwake) missing.push('保持唤醒关闭');
    else if (!data.wakeActive || !data.nativeActive) missing.push('唤醒保护未就绪');
    return missing.length ? {color:'yellow',text:missing.join(' · ')} : {color:'green',text:'全部正常运行'};
  }
  root.CourseAssistantCore = Object.freeze({normalize, directoryProgress, classifyPrompt, selectNext, canContinue, networkError, trafficState});
})(typeof globalThis !== 'undefined' ? globalThis : window);
