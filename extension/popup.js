'use strict';
const style = document.createElement('style'); style.textContent = CourseAssistantUI.css; document.head.append(style);
document.getElementById('app').innerHTML = CourseAssistantUI.markup(true);
const ui = CourseAssistantUI.bind(document);
let tabId, snapshot;
ui.toggle.disabled = true;
async function send(command) {
  try { return await chrome.tabs.sendMessage(tabId, {type: 'assistant:control', ...command}); }
  catch {ui.status.textContent = '请打开课程播放页；已打开时请刷新页面。'; ui.toggle.disabled = true; return null;}
}
function render(data) {
  if (!data) return;
  snapshot = data; CourseAssistantUI.render(ui, data); ui.toggle.disabled = false;
}
ui.toggle.addEventListener('click', async () => render(await send({action: snapshot?.enabled ? 'stop' : 'start'})));
ui.resume.addEventListener('click', async () => render(await send({action: 'resume'})));
ui.confirm.addEventListener('change', async () => render(await send({action: 'option', autoConfirm: ui.confirm.checked})));
ui['awake-option'].addEventListener('change', async () => render(await send({action: 'awake-option', keepAwake: ui['awake-option'].checked})));
ui['next-course'].addEventListener('change', async () => render(await send({action: 'course-option', autoNextCourse: ui['next-course'].checked})));
(async () => {
  const tabs = await chrome.tabs.query({active:true,currentWindow:true}); tabId = tabs[0]?.id;
  if (tabId == null) {ui.status.textContent='请打开课程播放页'; return;}
  render(await send({action:'status'}));
  setInterval(async () => render(await send({action:'status'})),1500);
})();
