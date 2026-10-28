// The editor's only way to reach the app.
const { contextBridge, ipcRenderer } = require("electron");

const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld("app", {
  state: call("editor:state"),
  add: call("editor:add"),
  update: call("editor:update"),
  remove: call("editor:remove"),
  duplicate: call("editor:duplicate"),
  move: call("editor:move"),
  reload: call("editor:reload"),
  devtools: call("editor:devtools"),
  center: call("editor:center"),
  pickFile: call("editor:pickFile"),
  settings: call("editor:settings"),
  openData: call("editor:openData"),
  openUrl: call("editor:openUrl"),
  copy: call("editor:copy"),
  addStats: call("editor:addStats"),
  allowFps: call("editor:allowFps"),
  onState: (fn) => ipcRenderer.on("editor:state", (_e, s) => fn(s)),
  onSelect: (fn) => ipcRenderer.on("editor:select", (_e, id) => fn(id)),
});
