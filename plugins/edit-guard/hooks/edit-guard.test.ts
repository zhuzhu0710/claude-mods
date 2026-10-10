import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'

const HOME = 'C:/Users/tester'
const DIR = `${HOME}/.claude/edit-guard-log`
const TARGET = 'C:/proj/a.txt'

type Files = Map<string, { text: string; mtimeMs: number }>

// 引擎在 Windows 上會把路徑改成反斜線，比對前統一成正斜線
const norm = (p: string) => p.split('\\').join('/')

// 記憶體中的檔案系統，取代 $.fs
function fakeFs(on: On, files: Files) {
  on('fs.read', ($, e) => {
    const f = files.get(norm(e.path))
    return f ? { value: f.text } : { deny: 'ENOENT' }
  })
  on('fs.write', ($, e) => {
    files.set(norm(e.path), { text: e.text, mtimeMs: Date.now() })
    return { value: undefined }
  })
  on('fs.list', ($, e) => {
    const dir = norm(e.path)
    const value = [...files.entries()]
      .filter(([p]) => p.startsWith(`${dir}/`))
      .map(([p, f]) => ({
        name: p.slice(dir.length + 1),
        kind: 'file' as const,
        size: f.text.length,
        mtimeMs: f.mtimeMs,
        isLink: false,
      }))
    return { value }
  })
  on('fs.stat', () => ({ deny: 'ENOENT' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }) as never)
}

function setup(on: On, files: Files) {
  mock.env(on, { USERPROFILE: HOME })
  fakeFs(on, files)
  on('session.id', () => ({ value: 'self-session' }))
}

function otherEdit(files: Files, ago: number) {
  const time = Date.now() - ago
  files.set(`${DIR}/other-session.json`, {
    text: JSON.stringify([{ file: 'c:/proj/a.txt', path: TARGET, time, session: 'other-session' }]),
    mtimeMs: time,
  })
}

test('沒有衝突時直接寫入並記錄', async ($, on) => {
  const files: Files = new Map()
  setup(on, files)
  on('tool.call', { tool: 'Write' }, () => ({ result: { type: 'create' } as never }))

  const ran = await $.tool.call({ tool: 'Write', file_path: TARGET, content: 'x' })
  expect(ran.deny).toBeUndefined()

  const log = JSON.parse(files.get(`${DIR}/self-session.json`)!.text)
  expect(log.length).toBe(1)
  expect(log[0].file).toBe('c:/proj/a.txt')
  expect(log[0].session).toBe('self-session')
})

test('別的對話三十分鐘內改過，問了之後選取消就擋下', async ($, on) => {
  const files: Files = new Map()
  otherEdit(files, 60_000)
  setup(on, files)

  let asked = ''
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    asked = e.questions[0].question
    return { result: { questions: e.questions, answers: { [asked]: '取消' } } as never }
  })
  let wrote = false
  on('tool.call', { tool: 'Write' }, () => {
    wrote = true
    return { result: { type: 'create' } as never }
  })

  const ran = await $.tool.call({ tool: 'Write', file_path: TARGET, content: 'x' })
  expect(asked).toContain(TARGET)
  expect(wrote).toBe(false)
  expect(ran.deny ?? ran.text).toContain('取消')
})

test('別的對話改過，選繼續就照常寫入', async ($, on) => {
  const files: Files = new Map()
  otherEdit(files, 60_000)
  setup(on, files)

  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    const q = e.questions[0].question
    return { result: { questions: e.questions, answers: { [q]: '繼續' } } as never }
  })
  let wrote = false
  on('tool.call', { tool: 'Write' }, () => {
    wrote = true
    return { result: { type: 'create' } as never }
  })

  await $.tool.call({ tool: 'Write', file_path: TARGET, content: 'x' })
  expect(wrote).toBe(true)
})

test('超過三十分鐘的紀錄不算衝突', async ($, on) => {
  const files: Files = new Map()
  otherEdit(files, 31 * 60_000)
  setup(on, files)

  let asked = false
  on('tool.call', { tool: 'AskUserQuestion' }, () => {
    asked = true
    return { result: {} as never }
  })
  let wrote = false
  on('tool.call', { tool: 'Write' }, () => {
    wrote = true
    return { result: { type: 'create' } as never }
  })

  await $.tool.call({ tool: 'Write', file_path: TARGET, content: 'x' })
  expect(asked).toBe(false)
  expect(wrote).toBe(true)
})
