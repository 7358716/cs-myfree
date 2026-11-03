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
import { readFileSync } from 'node:fs'
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
    /**
     * 同步读配置（启动时合并进内存 cfg 用）。
     *
     * 为什么必须同步：POST /config 会热更新内存 cfg，但**重启后**若不读盘，
     * 内存又会回到 patch 默认值 ⇒ 用户看到「保存成功，重启就变回去」。
     * 文件不存在返回 null。
     */
    readConfigSync() {
      try {
        return JSON.parse(readFileSync(join(dir, FILES.config), 'utf8'))
      } catch {
        return null
      }
    },
    async writeConfig(obj) {
      return atomicWriteJson(join(dir, FILES.config), obj)
    },

    async readChain(fallback = { chain: [] }) {
      return readJsonSafe(join(dir, FILES.chain), fallback)
    },
    /**
     * 同步读覆盖层（**只为插件启动时建 adapter 用**）。
     *
     * 为什么必须同步：adapter 在 apply() 里同步创建，而它需要「与页面完全一致」
     * 的生效链；异步读会让首轮请求跑在空覆盖层上（重启后第一次选路就错）。
     * 文件很小（<几 KB），同步读代价可忽略。文件不存在返回 null（区别于空表）。
     */
    readChainSync() {
      try {
        return JSON.parse(readFileSync(join(dir, FILES.chain), 'utf8'))
      } catch {
        return null
      }
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

    /**
     * 规范化覆盖层：把历史错名（kilo-free 等别名）改回真实源 id，
     * 并去掉因此产生的重复条目。
     *
     * 为什么需要：用户可能手填旧插件时代的名字（kilo-free），
     * 而真实源 id 是 kilo ⇒ 会多出一个指向同一源的重复候选，
     * 白白浪费一次失败重试。
     *
     * @param {(id:string)=>string} resolve 别名解析函数
     * @returns {Promise<{changed:boolean, before:number, after:number}>}
     */
    async normalizeChain(resolve) {
      try {
        const cur = await this.readChain({ chain: [] })
        const list = Array.isArray(cur?.chain) ? cur.chain : []
        if (list.length === 0) return { changed: false, before: 0, after: 0 }

        const seen = new Set()
        const out = []
        for (const e of list) {
          const provider = resolve ? resolve(e.provider) : e.provider
          const key = `${provider}\u0000${e.model}`
          if (seen.has(key)) continue          // 去重
          seen.add(key)
          const next = { ...e, provider }
          delete next._i
          out.push(next)
        }
        const changed = JSON.stringify(out) !== JSON.stringify(list.map((e) => { const c = { ...e }; delete c._i; return c }))
        if (changed) await this.writeChain({ chain: out, at: Date.now(), normalized: true })
        return { changed, before: list.length, after: out.length }
      } catch {
        return { changed: false, before: 0, after: 0 }
      }
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
