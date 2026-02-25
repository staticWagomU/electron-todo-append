'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  getConfig:    ()     => ipcRenderer.invoke('config:get'),
  addTodo:      (data) => ipcRenderer.invoke('todo:add', data),
  hide:         ()     => ipcRenderer.invoke('window:hide'),
  openSettings: ()     => ipcRenderer.invoke('window:open-settings'),

  onWindowShown:   (cb) => ipcRenderer.on('window:shown',   () => cb()),
  onConfigUpdated: (cb) => ipcRenderer.on('config:updated', () => cb()),
})
