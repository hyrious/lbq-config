import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderMarkdownStream } from './renderMarkdownStream'

await renderMarkdownStream((async function* () {
  const readme = readFileSync(join(import.meta.dirname, '../README.md'), 'utf-8')
  // 随机切分成若干块
  let pos = 0
  while (pos < readme.length) {
    const chunkSize = Math.floor(Math.random() * 20) + 1
    yield readme.slice(pos, pos + chunkSize)
    pos += chunkSize
    // 模拟网络延迟
    await new Promise(resolve => setTimeout(resolve, Math.random() * 100))
  }
})())
