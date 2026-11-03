/**
 * cs-myfree — 持久化状态（配置 + 链覆盖 + 账本摘要）
 *
 * 位置：`<DSH_HOME>/cs-myfree/`
 *   · config.json          插件配置（**不含任何密钥**）
 *   · chain-overrides.json 链覆盖层
 *   · probe-cache.json     探测结果缓存（避免每次打开页面都打网络）
 *
 * 纪律：原子写 + 权限 0600 + 永不存凭据。
 *
 * @module cs-myfree/web/state
 */

import { readFile, writeFile, rename, mkdir, chmod, unlink, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** 状态目录 */
export function stateDir(dshHome) {
  const home = dshHome || process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'cs-myfree')
}

async function atomicWriteJson(file, obj) {
  const dir = file.slice(0, file.lastIndexOf('/'))
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const tmp = `${dir}/.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`
  const body = JSON.stringify(obj, null, 2)
  try {
    await writeFile(tmp, body, { mode: 0o600 })
    await chmod(tmp, 0o600).catch(() => {})
    await rename(tmp, file)
    return true
  } catch {
    await unlink(tmp).catch(() => {})
    return false
  }
}

async function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}

export const FILES = Object.freeze({
  config: 'config.json',
  chain: 'chain-overrides.json',
  probe: 'probe-cache.json',
})

export function createState(dshHome) {
  const dir = stateDir(dshHome)
  return {
    dir,

    async readConfig(fallback = {}) {
      return readJsonSafe(join(dir, FILES.config), fallback)
    },
    async writeConfig(obj) {
      return atomicWriteJson(join(dir, FILES.config), obj)
    },

    async readChain(fallback = { chain: [] }) {
      return readJsonSafe(join(dir, FILES.chain), fallback)
    },
    async writeChain(obj) {
      return atomicWriteJson(join(dir, FILES.chain), obj)
    },

    async readProbe(fallback = null) {
      return readJsonSafe(join(dir, FILES.probe), fallback)
    },
    async writeProbe(obj) {
      return atomicWriteJson(join(dir, FILES.probe), obj)
    },

    /** 目录概况（给诊断页用） */
    async overview() {
      try {
        const names = await readdir(dir)
        const out = []
        for (const n of names) {
          const st = await stat(join(dir, n)).catch(() => null)
          if (st && st.isFile()) out.push({ name: n, bytes: st.size, at: st.mtimeMs })
        }
        return { exists: true, dir, files: out }
      } catch {
        return { exists: false, dir, files: [] }
      }
    },
  }
}
