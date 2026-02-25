'use strict'

const {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  dialog,
} = require('electron')
const fs   = require('node:fs')
const path = require('node:path')
const os   = require('node:os')
const { appendTaskToFile } = require('@wagomu/todotxt-parser')

// ── Config ────────────────────────────────────────────────────────────────────

let configPath

const DEFAULT_CONFIG = {
  filePath: path.join(os.homedir(), 'todo.txt'),
  shortcut: 'CommandOrControl+Shift+T',
  templates: [
    { name: '仕事/全般',     projects: ['work'],     contexts: [],           priority: null },
    { name: '仕事/定例会議', projects: ['work'],     contexts: ['meeting'],  priority: 'A'  },
    { name: '個人/全般',     projects: ['personal'], contexts: [],           priority: null },
  ],
}

function readConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    const cfg = { ...DEFAULT_CONFIG, ...raw }
    if (!Array.isArray(cfg.templates)) cfg.templates = []
    return cfg
  } catch {
    return structuredClone(DEFAULT_CONFIG)
  }
}

function writeConfig(cfg) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8')
}

// ── Windows ───────────────────────────────────────────────────────────────────

let mainWindow     = null
let settingsWindow = null
let isSettingsOpen = false
let blurHideTimer  = null   // debounce handle to cancel blur-hide on shortcut

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 360,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    show: false,
    skipTaskbar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  })
  mainWindow.loadFile('index.html')
  // Delay hide so that toggleMainWindow (shortcut) can cancel it if it fires first
  mainWindow.on('blur', () => {
    if (!isSettingsOpen) {
      blurHideTimer = setTimeout(() => mainWindow.hide(), 150)
    }
  })
}

function openSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus()
    return
  }
  isSettingsOpen = true
  mainWindow.setAlwaysOnTop(false)

  settingsWindow = new BrowserWindow({
    width: 460,
    height: 600,
    resizable: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  })
  settingsWindow.loadFile('index.html', { query: { view: 'settings' } })
  settingsWindow.on('closed', () => {
    settingsWindow = null
    isSettingsOpen = false
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setAlwaysOnTop(true)
      mainWindow.webContents.send('config:updated')
    }
  })
}

function toggleMainWindow() {
  if (!mainWindow) return
  // Cancel any blur-triggered hide that may have fired just before this shortcut
  clearTimeout(blurHideTimer)

  if (mainWindow.isVisible()) {
    mainWindow.hide()
  } else {
    mainWindow.show()
    mainWindow.focus()
    // send after OS actually grants focus to avoid focus() racing with show()
    mainWindow.once('focus', () => mainWindow.webContents.send('window:shown'))
  }
}

// ── IPC handlers ──────────────────────────────────────────────────────────────

ipcMain.handle('config:get', () => readConfig())

ipcMain.handle('config:save', (_, cfg) => {
  const prev = readConfig()
  writeConfig(cfg)
  if (prev.shortcut !== cfg.shortcut) {
    globalShortcut.unregisterAll()
    try {
      globalShortcut.register(cfg.shortcut, toggleMainWindow)
    } catch (e) {
      console.error('Shortcut registration failed:', e.message)
    }
  }
  return { ok: true }
})

ipcMain.handle('todo:add', (_, { text, priority, dueToday, templateIndex }) => {
  try {
    const cfg   = readConfig()
    const tmpl  = (templateIndex >= 0 && cfg.templates[templateIndex]) || null
    const today = new Date().toISOString().slice(0, 10)

    let description = text.trim()
    if (tmpl) {
      const tags = [
        ...tmpl.projects.map(p => `+${p}`),
        ...tmpl.contexts.map(c => `@${c}`),
      ].join(' ')
      if (tags) description += ` ${tags}`
    }
    if (dueToday) description += ` due:${today}`

    const todo = {
      completed:    false,
      priority:     priority || undefined,
      creationDate: today,
      description,
      projects:     tmpl?.projects ?? [],
      contexts:     tmpl?.contexts ?? [],
      tags:         dueToday ? { due: today } : {},
      raw:          '',
    }

    const filePath = cfg.filePath.replace(/^~(?=$|\/)/, os.homedir())
    const existing = fs.existsSync(filePath)
      ? fs.readFileSync(filePath, 'utf8').trimEnd()
      : ''
    fs.writeFileSync(filePath, appendTaskToFile(existing, todo) + '\n', 'utf8')
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('window:hide', () => mainWindow?.hide())

ipcMain.handle('window:open-settings', () => openSettingsWindow())

ipcMain.handle('dialog:open-file', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [
      { name: 'Text Files', extensions: ['txt'] },
      { name: 'All Files',  extensions: ['*'] },
    ],
  })
  return canceled ? null : filePaths[0]
})

// ── Lifecycle ─────────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  configPath = path.join(app.getPath('userData'), 'config.json')
  createMainWindow()
  const cfg = readConfig()
  try {
    globalShortcut.register(cfg.shortcut, toggleMainWindow)
  } catch (e) {
    console.error('Initial shortcut registration failed:', e.message)
  }
  if (process.platform === 'darwin') app.dock.hide()
})

// keep alive after all windows are closed (global shortcut brings window back)
app.on('window-all-closed', () => {})
app.on('will-quit', () => globalShortcut.unregisterAll())
