/**
 * End-to-end check of the Mihomo installer + process manager against the real
 * official archive for this machine. Opt-in: set MIHOMO_ARCHIVE to the pinned
 * asset for this OS/arch (e.g. mihomo-linux-arm64-v1.19.33.gz); skipped otherwise.
 */
import { afterAll, describe, expect, it, vi } from 'vitest'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'goxf-mihomo-'))
vi.mock('electron', () => ({ app: { getPath: () => dir } }))

const archive = process.env.MIHOMO_ARCHIVE
const enabled = Boolean(archive && existsSync(archive))

afterAll(async () => {
  const m = await import('./goxfMihomo')
  await m.stopAllMihomo()
  rmSync(dir, { recursive: true, force: true })
})

describe.runIf(enabled)('goxf Mihomo runtime (real binary)', () => {
  it('installs the official archive, serves an authenticated loopback entry, measures delay, stops', async () => {
    const m = await import('./goxfMihomo')
    expect(m.mihomoKernelStatus().installed).toBe(false)
    await expect(m.installMihomoArchive(Buffer.from('nope'))).rejects.toThrow(/SHA-256|本机需要/)
    const status = await m.installMihomoArchive(readFileSync(archive!))
    expect(status).toMatchObject({ installed: true, version: '1.19.33' })

    // Upstream "node": a plain socks5 Mihomo that goes direct.
    const upstreamPort = await m.freePort()
    const bin = join(dir, 'mihomo', 'bin', 'mihomo')
    const upstream = spawn(bin, ['-d', join(dir, 'up')], {
      stdio: 'ignore',
      env: { ...process.env, CLASH_CONFIG_STRING: Buffer.from(`socks-port: ${upstreamPort}\nbind-address: 127.0.0.1\nrules: ["MATCH,DIRECT"]\n`).toString('base64') }
    })
    try {
      const port = 20000 + Math.floor(Math.random() * 10000)
      const node = { name: '香港 01', protocol: 'socks5', proxy: { name: '香港 01', type: 'socks5', server: '127.0.0.1', port: upstreamPort } }
      const snapshot = { kind: 'node' as const, target: '香港 01', nodes: [node], groups: [] }
      await m.ensureMihomoEntry('px_test', { snapshot, port, username: 'u1', password: 'p1' })
      await m.ensureMihomoEntry('px_test', { snapshot, port, username: 'u1', password: 'p1' }) // reused
      // The config file (with the credentials) is gone once Mihomo has read it.
      const runDir = join(dir, 'mihomo', 'run')
      expect(readdirSync(runDir).flatMap((d) => readdirSync(join(runDir, d))).filter((f) => f.endsWith('.yaml'))).toEqual([])
      const curl = (proxy: string) =>
        execFileSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '10', '-x', proxy, 'https://www.gstatic.com/generate_204'], { encoding: 'utf8' })
      expect(curl(`socks5h://u1:p1@127.0.0.1:${port}`)).toBe('204')
      expect(() => curl(`socks5h://u1:wrong@127.0.0.1:${port}`)).toThrow()

      const delays = await m.mihomoDelays('src1', [node], ['香港 01'])
      expect(delays['香港 01']).toMatchObject({ ok: true })

      await m.stopMihomoEntry('px_test')
      expect(await m.isPortFree(port)).toBe(true)
    } finally {
      upstream.kill()
    }
  }, 60_000)
})
