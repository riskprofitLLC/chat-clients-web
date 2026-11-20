// После сборки подставляет в dist/sw.js реальный список ассетов и версию
// кэша из хэша сборки. Без этого сервис-воркер кэшировал бы только shell и
// версия кэша задавалась бы вручную.
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

const DIST = resolve(import.meta.dirname, '../dist')

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

const files = walk(DIST)
  .filter((file) => !file.endsWith('sw.js') && !file.endsWith('.map'))
  .sort()

// версия кэша: хэш имён и содержимого — меняется ровно при смене сборки
const hash = createHash('sha256')
for (const file of files) {
  hash.update(relative(DIST, file))
  hash.update(readFileSync(file))
}
const version = `chat-${hash.digest('hex').slice(0, 12)}`

const precache = files.map((file) => `./${relative(DIST, file).split(sep).join('/')}`)
// корневой документ нужен для офлайн-навигации
if (!precache.includes('./index.html')) precache.unshift('./index.html')

const swPath = join(DIST, 'sw.js')
const source = readFileSync(swPath, 'utf8')
const filled = source
  .replace("'__CACHE_VERSION__'", JSON.stringify(version))
  .replace('__PRECACHE__', JSON.stringify(precache, null, 2))
writeFileSync(swPath, filled)
console.log(`sw.js: версия ${version}, ассетов ${precache.length}`)
