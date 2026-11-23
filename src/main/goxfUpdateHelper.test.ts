import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HELPER_SOURCE, type HelperJob } from './goxfUpdateHelper'

// Runs the real helper with plain node on temp folders (Linux: taskkill is skipped, relaunch just fails to spawn).
function setup(): { root: string; app: string; data: string; job: Omit<HelperJob, 'mode'> } {
  const root = mkdtempSync(join(tmpdir(), 'botark-helper-'))
  const app = join(root, 'BotArk')
  const data = join(app, 'BotArk-Data')
  mkdirSync(join(app, 'resources'), { recursive: true })
  mkdirSync(data)
  writeFileSync(join(app, 'BotArk.exe'), 'old exe')
  writeFileSync(join(app, 'resources', 'app.asar'), 'old asar')
  writeFileSync(join(data, 'keep.txt'), 'user data')
  writeFileSync(join(app, '.botark-update.zip'), 'zip')
  return {
    root,
    app,
    data,
    job: {
      appDir: app,
      exeName: 'BotArk.exe',
      pid: 999_999_9,
      logFile: join(data, 'update.log'),
      lockFile: join(data, 'update-in-progress.lock'),
      readyFile: join(data, 'update-helper.ready'),
      zipFile: join(app, '.botark-update.zip'),
      stageDir: join(app, '.botark-update-stage'),
      backupDir: join(app, '.botark-update-old'),
      keep: ['BotArk-Data', '.botark-update-stage', '.botark-update-old', '.botark-update.zip']
    }
  }
}

function run(root: string, job: HelperJob): string {
  const script = join(root, 'helper.cjs')
  const jobFile = join(root, 'job.json')
  writeFileSync(script, HELPER_SOURCE)
  writeFileSync(jobFile, JSON.stringify(job))
  execFileSync(process.execPath, [script, jobFile], { timeout: 30_000 })
  return readFileSync(job.logFile, 'utf8')
}

describe('update helper', () => {
  it('full: replaces the app, keeps BotArk-Data, writes ready, drops the lock and zip', () => {
    const { root, app, data, job } = setup()
    const src = join(job.stageDir, 'BotArk')
    mkdirSync(join(src, 'resources'), { recursive: true })
    writeFileSync(join(src, 'BotArk.exe'), 'new exe')
    writeFileSync(join(src, 'resources', 'app.asar'), 'new asar')
    const log = run(root, { ...job, mode: 'full', srcDir: src })
    expect(readFileSync(join(app, 'BotArk.exe'), 'utf8')).toBe('new exe')
    expect(readFileSync(join(app, 'resources', 'app.asar'), 'utf8')).toBe('new asar')
    expect(readFileSync(join(data, 'keep.txt'), 'utf8')).toBe('user data')
    expect(existsSync(job.readyFile)).toBe(true)
    expect(existsSync(job.lockFile)).toBe(false)
    expect(existsSync(job.zipFile)).toBe(false)
    expect(log).toMatch(/helper: swapped/)
    expect(log).toMatch(/helper: done/)
  })

  it('full: a failed copy rolls back to the old app', () => {
    const { root, app, job } = setup()
    const log = run(root, { ...job, mode: 'full', srcDir: join(root, 'missing') })
    expect(readFileSync(join(app, 'BotArk.exe'), 'utf8')).toBe('old exe')
    expect(log).toMatch(/swap failed/)
    expect(existsSync(job.zipFile)).toBe(true)
  })

  it('delta: replaces only the listed files', () => {
    const { root, app, job } = setup()
    mkdirSync(join(job.stageDir, 'resources'), { recursive: true })
    writeFileSync(join(job.stageDir, 'resources', 'app.asar'), 'patched asar')
    const log = run(root, { ...job, mode: 'delta', files: ['resources/app.asar'] })
    expect(readFileSync(join(app, 'resources', 'app.asar'), 'utf8')).toBe('patched asar')
    expect(readFileSync(join(app, 'BotArk.exe'), 'utf8')).toBe('old exe')
    expect(log).toMatch(/delta applied \(1 files\)/)
  })
})
