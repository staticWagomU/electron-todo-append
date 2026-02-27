'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  getConfig:       ()     => ipcRenderer.invoke('config:get'),
  addTodo:         (data) => ipcRenderer.invoke('todo:add', data),
  listUrgentTodos: ()     => ipcRenderer.invoke('todo:list-urgent'),
  completeTodo:    (data) => ipcRenderer.invoke('todo:complete', data),
  hide:            ()     => ipcRenderer.invoke('window:hide'),
  openSettings:    ()     => ipcRenderer.invoke('window:open-settings'),

  onWindowShown:     (cb) => ipcRenderer.on('window:shown',      () => cb()),
  onWindowShownList: (cb) => ipcRenderer.on('window:shown-list', () => cb()),
  onConfigUpdated:   (cb) => ipcRenderer.on('config:updated',    () => cb()),
})
