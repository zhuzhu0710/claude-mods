import type { Register, EngineInterface } from 'claude-code'

// 紀錄保留時間：三十分鐘
const WINDOW_MS = 30 * 60 * 1000
const FILE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'] as const
const CONTINUE = '繼續'
const CANCEL = '取消'

type Entry = { file: string; path: string; time: number; session: string }

// 每個對話只寫自己的檔案（<對話ID>.json），避免多個對話同時寫同一個檔案互相蓋掉
async function logDir($: EngineInterface) {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '.'
  return `${home.replace(/\\/g, '/')}/.claude/edit-guard-log`
}

function pathOf(e: unknown): string | undefined {
  const input = e as { file_path?: unknown; notebook_path?: unknown }
  const p = input.file_path ?? input.notebook_path
  return typeof p === 'string' && p !== '' ? p : undefined
}

// 比對用的鍵：解析連結、統一斜線；Windows 路徑不分大小寫
async function keyOf($: EngineInterface, path: string) {
  let real: string | undefined
  try {
    real = (await $.fs.stat(path, { resolve: true })).realPath
  } catch {
    real = undefined
  }
  const p = (real ?? path).replace(/\\/g, '/').replace(/\/+/g, '/')
  return /^[A-Za-z]:\//.test(p) ? p.toLowerCase() : p
}

function parse(text: string): Entry[] {
  try {
    const data = JSON.parse(text)
    return Array.isArray(data) ? data : []
  } catch {
    return []
  }
}

function hhmm(time: number) {
  const d = new Date(time)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

async function readText($: EngineInterface, path: string) {
  try {
    return await $.fs.read(path)
  } catch {
    return '[]'
  }
}

async function listJson($: EngineInterface, dir: string) {
  try {
    const entries = await $.fs.list(dir)
    return entries.filter(f => f.kind === 'file' && f.name.endsWith('.json'))
  } catch {
    return []
  }
}

// 刪掉超過三十分鐘沒更新的對話紀錄檔
async function sweep($: EngineInterface, dir: string, now: number) {
  for (const f of await listJson($, dir)) {
    if (now - f.mtimeMs <= WINDOW_MS) continue
    const target = `${dir}/${f.name}`
    const argv = /^[A-Za-z]:\//.test(dir)
      ? ['cmd', '/c', 'del', '/q', target.replace(/\//g, '\\')]
      : ['rm', '-f', target]
    try {
      await $.process.run(argv)
    } catch {
      // 刪不掉就留著，讀取時會依時間略過
    }
  }
}

async function othersTouching($: EngineInterface, key: string, self: string) {
  const dir = await logDir($)
  const now = Date.now()
  const hits: Entry[] = []
  for (const f of await listJson($, dir)) {
    if (f.name === `${self}.json` || now - f.mtimeMs > WINDOW_MS) continue
    for (const entry of parse(await readText($, `${dir}/${f.name}`))) {
      if (entry.session !== self && entry.file === key && now - entry.time <= WINDOW_MS) {
        hits.push(entry)
      }
    }
  }
  return hits.sort((a, b) => b.time - a.time)
}

// 同一對話內並行的編輯依序寫入自己的紀錄檔
let queue: Promise<void> = Promise.resolve()

async function record($: EngineInterface, entry: Entry) {
  const previous = queue
  let release = () => {}
  queue = new Promise<void>(resolve => (release = resolve))
  await previous
  try {
    const dir = await logDir($)
    const own = `${dir}/${entry.session}.json`
    const fresh = parse(await readText($, own)).filter(x => entry.time - x.time <= WINDOW_MS)
    await $.fs.write(own, JSON.stringify([...fresh, entry], null, 2))
    await sweep($, dir, entry.time)
  } finally {
    release()
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await sweep($, await logDir($), Date.now())
    return next(e)
  })

  for (const tool of FILE_TOOLS) {
    on('tool.call', { tool }, async ($, e, next) => {
      const path = pathOf(e)
      if (path === undefined) return next(e)

      const self = await $.session.id()
      const key = await keyOf($, path)
      const hits = await othersTouching($, key, self)

      if (hits.length > 0) {
        const who = hits
          .slice(0, 3)
          .map(h => `${hhmm(h.time)} 對話 ${h.session.slice(0, 8)}`)
          .join('、')
        const verb = e.tool === 'Write' ? '寫入' : '編輯'
        const question = `過去三十分鐘內有其他對話改過 ${path}（${who}）。要繼續${verb}嗎？`
        let answer = CANCEL
        try {
          answer = await $.ui.ask(question, { header: '檔案衝突', options: [CANCEL, CONTINUE] })
        } catch {
          answer = CANCEL
        }
        if (answer !== CONTINUE) {
          return {
            deny: `${$.plugin.name}：使用者取消了對 ${path} 的修改（其他對話近期改過此檔）。請先詢問使用者下一步。`,
          }
        }
      }

      const ran = await next(e)
      if (ran.deny === undefined && ran.isError !== true) {
        try {
          await record($, { file: key, path, time: Date.now(), session: self })
        } catch (err) {
          $.ui.log(`${$.plugin.name}：寫入紀錄失敗：${String(err)}`, { to: 'debug' })
        }
      }
      return ran
    }).catch(($, e, next) => next(e))
  }
}
