/**
 * Precise syntax report for the Client parts, using the `acorn` parser that
 * ships inside the DSH installation (the workspace has no package-manager tree
 * of its own). Run it with the Desktop Electron executable:
 *
 *   ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" scripts/check-parts.mjs
 *
 * The parser is read through the asar-aware filesystem and imported as a data
 * URL, because the ESM loader cannot load a file path inside app.asar.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = dirname(here)
const sourceDir = join(root, 'src-client')
const installDir = process.env.DSH_INSTALL_DIR || ''
// DSH_INSTALL_DIR points at <asar>/dsh/node_modules/@deepseek-ai/dsh, so the
// sibling packages live two directories up.
const nodeModules = installDir === '' ? '' : dirname(dirname(installDir))

async function loadAcorn() {
  const candidates = [
    join(nodeModules, 'acorn', 'dist', 'acorn.mjs'),
    join(nodeModules, 'acorn', 'dist', 'acorn.js'),
  ]
  for (const candidate of candidates) {
    try {
      const source = readFileSync(candidate, 'utf8')
      if (candidate.endsWith('.mjs')) {
        const dataUrl = 'data:text/javascript;base64,' + Buffer.from(source, 'utf8').toString('base64')
        return await import(dataUrl)
      }
      // The CommonJS build exposes `module.exports`; wrap it as an ES module.
      const dataUrl = 'data:text/javascript;base64,' + Buffer.from(
        'const module={exports:{}};const exports=module.exports;(function(module,exports,require){' + source + '\n})(module,exports,()=>{throw new Error("no require")});export default module.exports;export const parse=module.exports.parse;',
        'utf8').toString('base64')
      return await import(dataUrl)
    } catch (error) {
      process.stdout.write('acorn candidate failed: ' + candidate + ' (' + error.message + ')\n')
    }
  }
  throw new Error('acorn is not reachable from ' + nodeModules)
}

const acorn = await loadAcorn()
const files = readdirSync(sourceDir).filter((name) => name.endsWith('.js')).sort()
let failed = 0

for (const name of files) {
  // `00-head.js` opens the loader call, `30-shell.js` ends with the factory's
  // `return`, and `99-tail.js` closes the loader call: all three are intentional
  // fragments, so they are not parsed standalone.
  if (name === '00-head.js' || name === '30-shell.js' || name === '99-tail.js') continue
  const source = readFileSync(join(sourceDir, name), 'utf8')
  try {
    acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true })
    process.stdout.write('ok    ' + name + '\n')
  } catch (error) {
    failed += 1
    process.stdout.write('FAIL  ' + name + ' -> ' + error.message + '\n')
    const line = error.loc && error.loc.line ? error.loc.line : 0
    const lines = source.split(/\r?\n/)
    for (let i = Math.max(1, line - 2); i <= Math.min(lines.length, line + 1); i += 1) {
      process.stdout.write('  ' + (i === line ? '>' : ' ') + ' ' + i + ': ' + lines[i - 1].trim().slice(0, 220) + '\n')
    }
  }
}

process.stdout.write(failed === 0 ? 'all parts parsed\n' : String(failed) + ' part(s) failed\n')
process.exitCode = failed === 0 ? 0 : 1
