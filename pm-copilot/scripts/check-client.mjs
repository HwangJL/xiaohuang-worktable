/**
 * Syntax-check every Client part on its own.
 *
 * `new Function(body)` compiles the body without running it, so a part is
 * checked for parse errors even though it references identifiers that only
 * exist in the concatenated factory scope. The script prints the first
 * offending file and the parser's line, which is what a whole-file check
 * reports ambiguously.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const sourceDir = join(root, 'src-client')
const files = readdirSync(sourceDir).filter((name) => name.endsWith('.js')).sort()

const wrapperPrefixLines = 2
let failed = 0

for (const name of files) {
  const source = readFileSync(join(sourceDir, name), 'utf8')
  try {
    // eslint-disable-next-line no-new-func
    new Function('require', 'React', 'h', 'PM', 'NS', source)
    process.stdout.write('ok    ' + name + '\n')
  } catch (error) {
    failed += 1
    process.stdout.write('FAIL  ' + name + ' -> ' + error.message + '\n')
    const match = /<anonymous>:(\d+)/.exec(String(error.stack || ''))
    if (match) {
      const target = Math.max(1, Number(match[1]) - wrapperPrefixLines)
      const lines = source.split(/\r?\n/)
      process.stdout.write('  near line ' + target + ': ' + (lines[target - 1] || '').trim().slice(0, 200) + '\n')
      for (let offset = 1; offset <= 3; offset += 1) {
        const probe = lines[target - 1 - offset]
        if (probe !== undefined) process.stdout.write('  -' + offset + ': ' + probe.trim().slice(0, 160) + '\n')
      }
    }
  }
}

process.stdout.write(failed === 0 ? 'all parts parsed\n' : String(failed) + ' part(s) failed\n')
process.exitCode = failed === 0 ? 0 : 1
