'use strict'

const {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  dialog,
  Tray,
  Menu,
  nativeImage,
} = require('electron')
const fs   = require('node:fs')
const path = require('node:path')
const os   = require('node:os')
const zlib = require('node:zlib')
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

// ── Tray icon ─────────────────────────────────────────────────────────────────

/**
 * Build a 16x16 RGBA PNG of a "T" (Todo) shape at runtime, so no asset file
 * is required.  setTemplateImage(true) lets macOS auto-invert for dark mode.
 */
function buildTrayIcon() {
  const size = 16
  const rows = []
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4, 0)  // filter byte + RGBA
    row[0] = 0                                  // filter type = None
    for (let x = 0; x < size; x++) {
      // "T" shape: horizontal top bar (y 3-5, x 2-13) + vertical stem (y 3-13, x 6-9)
      const inBar  = (y >= 3 && y <= 5 && x >= 2 && x <= 13)
      const inStem = (y >= 3 && y <= 13 && x >= 6 && x <= 9)
      row[1 + x * 4 + 3] = (inBar || inStem) ? 255 : 0  // alpha; RGB stays 0 (black)
    }
    rows.push(row)
  }
  const compressed = zlib.deflateSync(Buffer.concat(rows))

  const crc32 = buf => {
    const t = Array.from({ length: 256 }, (_, i) => {
      let c = i
      for (let j = 0; j < 8; j++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
      return c
    })
    let crc = 0xFFFFFFFF
    for (const b of buf) crc = t[(crc ^ b) & 0xFF] ^ (crc >>> 8)
    return (crc ^ 0xFFFFFFFF) >>> 0
  }
  const chunk = (type, data) => {
    const l = Buffer.alloc(4); l.writeUInt32BE(data.length)
    const t = Buffer.from(type)
    const c = Buffer.alloc(4); c.writeUInt32BE(crc32(Buffer.concat([t, data])))
    return Buffer.concat([l, t, data, c])
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8; ihdr[9] = 6   // 8-bit depth, RGBA color type

  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),  // PNG signature
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ])
  const img = nativeImage.createFromBuffer(png)
  img.setTemplateImage(true)  // macOS: auto dark/light mode inversion
  return img
}

// ── Tray ──────────────────────────────────────────────────────────────────────

let tray = null

function createTray() {
  tray = new Tray(buildTrayIcon())
  tray.setToolTip('TodoTxtAppend')
  // On macOS, click event is suppressed when a context menu is set,
  // so the toggle action lives as the first menu item (standard macOS convention).
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'ウィンドウを表示/非表示', click: toggleMainWindow },
    { type: 'separator' },
    { label: '設定',                   click: openSettingsWindow },
    { type: 'separator' },
    { label: '終了',                   click: () => app.quit() },
  ]))
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
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
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
      preload: path.join(__dirname, 'preload-settings.js'),
      contextIsolation: true,
      nodeIntegration: false,
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
    const today = new Date().toLocaleDateString('sv', { timeZone: 'Asia/Tokyo' })

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
  createTray()
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
