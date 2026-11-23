/**
 * GOXF zip self-update without PowerShell.
 *
 * The app writes HELPER_SOURCE to BotArk-Data/update-helper.cjs plus a job file, then runs it with an
 * Electron exe in Node mode (ELECTRON_RUN_AS_NODE=1): the new staged BotArk.exe for a full update, the
 * current one for a delta (a delta never touches the runtime, and Node mode opens no app.asar).
 * The helper logs to update.log with the same appendFileSync the app uses, and writes `ready` first,
 * so the app only quits once the helper is really running.
 *
 * Full:  move every old top-level entry (except BotArk-Data and our temp files) aside, copy the new
 *        app in (copy, not move: the helper itself runs from the staged folder), relaunch.
 * Delta: move each changed resources/ file aside and the staged one in, relaunch.
 * Any failure puts the old files back and relaunches the old version.
 * The app removes the stage and backup folders on its next start.
 */

export interface HelperJob {
  mode: 'full' | 'delta'
  appDir: string
  exeName: string
  /** pid of the app that is quitting */
  pid: number
  logFile: string
  lockFile: string
  /** written by the helper as soon as it runs */
  readyFile: string
  /** downloaded zip, deleted after success */
  zipFile: string
  stageDir: string
  backupDir: string
  /** full: the new app root inside stageDir */
  srcDir?: string
  /** delta: forward-slash paths relative to appDir, present under stageDir */
  files?: string[]
  /** full: top-level names never moved aside */
  keep?: string[]
}

export const UPDATE_BACKUP_DIR = '.botark-update-old'
export const UPDATE_STAGE_DIR = '.botark-update-stage'
export const UPDATE_HELPER_FILE = 'update-helper.cjs'
export const UPDATE_JOB_FILE = 'update-job.json'
export const UPDATE_READY_FILE = 'update-helper.ready'

export const HELPER_SOURCE = String.raw`'use strict'
const fs = require('fs')
const path = require('path')
const cp = require('child_process')
const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
let locked = true
function log(m) {
  try { fs.appendFileSync(job.logFile, '[' + new Date().toISOString() + '] helper: ' + m + '\r\n') } catch (e) {}
  if (locked) { try { fs.writeFileSync(job.lockFile, new Date().toISOString()) } catch (e) {} }
}
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
function alive(pid) { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
function killOthers() {
  if (process.platform !== 'win32') return
  try {
    cp.spawnSync('taskkill', ['/F', '/FI', 'IMAGENAME eq ' + job.exeName, '/FI', 'PID ne ' + process.pid], { windowsHide: true, timeout: 10000 })
    log('killed leftover ' + job.exeName + ' processes')
  } catch (e) {}
}
let killed = false
function retry(what, fn) {
  for (let i = 0; ; i++) {
    try { return fn() } catch (e) {
      if (i === 10 && !killed) { killed = true; killOthers() }
      if (i >= 40) throw new Error(what + ': ' + e.message)
      sleep(500)
    }
  }
}
function moveTo(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true })
  retry('move ' + from, () => fs.renameSync(from, to))
}
function relaunch() {
  locked = false
  try { fs.unlinkSync(job.lockFile) } catch (e) {}
  const env = Object.assign({}, process.env)
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_NO_ASAR
  const exe = path.join(job.appDir, job.exeName)
  try {
    const child = cp.spawn(exe, [], { cwd: job.appDir, env, detached: true, stdio: 'ignore', windowsHide: false })
    child.on('error', (e) => log('relaunch failed: ' + e.message))
    child.unref()
    log('relaunched ' + exe)
  } catch (e) { log('relaunch failed: ' + e.message) }
}

log(job.mode + ' update, helper pid ' + process.pid + ', waiting for app pid ' + job.pid)
try { fs.writeFileSync(job.readyFile, String(process.pid)) } catch (e) {}
for (let i = 0; i < 60 && alive(job.pid); i++) sleep(500)
if (alive(job.pid)) {
  log('app still running after 30s; killing it')
  try { process.kill(job.pid) } catch (e) {}
  sleep(1000)
} else log('app exited')

try { fs.rmSync(job.backupDir, { recursive: true, force: true }) } catch (e) {}
const undo = []
let ok = false
let phase = 'out'
try {
  if (job.mode === 'full') {
    const keep = new Set(job.keep)
    for (const name of fs.readdirSync(job.appDir)) {
      if (keep.has(name)) continue
      moveTo(path.join(job.appDir, name), path.join(job.backupDir, name))
      undo.push(name)
    }
    log('moved ' + undo.length + ' old entries aside')
    phase = 'in'
    for (const name of fs.readdirSync(job.srcDir)) {
      if (name === 'BotArk-Data') continue
      retry('copy ' + name, () => fs.cpSync(path.join(job.srcDir, name), path.join(job.appDir, name), { recursive: true, force: true }))
    }
  } else {
    for (const f of job.files) {
      const dst = path.join(job.appDir, ...f.split('/'))
      const bak = path.join(job.backupDir, ...f.split('/'))
      const had = fs.existsSync(dst)
      if (had) moveTo(dst, bak)
      undo.push({ dst, bak, had })
      moveTo(path.join(job.stageDir, ...f.split('/')), dst)
    }
  }
  ok = true
  log(job.mode === 'full' ? 'swapped' : 'delta applied (' + job.files.length + ' files)')
} catch (e) {
  log('swap failed: ' + e.message + '; rolling back')
  if (job.mode === 'full') {
    // New entries came in only after every old one was out: drop them, then restore.
    if (phase === 'in') {
      const keep = new Set(job.keep)
      for (const name of fs.readdirSync(job.appDir)) {
        if (!keep.has(name)) { try { fs.rmSync(path.join(job.appDir, name), { recursive: true, force: true }) } catch (e2) {} }
      }
    }
    for (const name of undo) {
      try { retry('restore ' + name, () => fs.renameSync(path.join(job.backupDir, name), path.join(job.appDir, name))) } catch (e2) { log(e2.message) }
    }
  } else {
    for (const d of undo.reverse()) {
      try { fs.rmSync(d.dst, { force: true }) } catch (e2) {}
      if (d.had) { try { fs.renameSync(d.bak, d.dst) } catch (e2) { log('restore failed: ' + d.dst) } }
    }
  }
}
relaunch()
if (ok) { try { fs.rmSync(job.zipFile, { force: true }) } catch (e) {} }
log('done')
`
