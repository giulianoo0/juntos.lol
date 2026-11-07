import { build } from 'esbuild'
import { writeFile } from 'node:fs/promises'

const root = new URL('..', import.meta.url).pathname
const out = await build({
  entryPoints: [`${root}src/sdk-entry.ts`],
  bundle: true,
  write: false,
  format: 'iife',
  target: 'es2020',
  minify: true,
})
const js = out.outputFiles[0].text
await writeFile(`${root}src/sdk.gen.ts`, `export default ${JSON.stringify(js)}\n`)
