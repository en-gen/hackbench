// Throwaway harness for the music import prototype. Not part of the app.
import { defineConfig, type Plugin } from 'vite'
import { createReadStream, existsSync } from 'fs'
import { resolve } from 'path'

const repo = resolve(__dirname, '../..')
const spcDist = resolve(repo, 'node_modules/@smwcentral/spc-player/dist')

/** Serve the SPC player's script and wasm where spc-playback.ts expects them. */
const spcAssets: Plugin = {
  name: 'spc-assets',
  configureServer(server) {
    server.middlewares.use('/hackbench/spc', (req, res, next) => {
      const file = resolve(spcDist, (req.url ?? '').replace(/^\//, '').split('?')[0])
      if (!file.startsWith(spcDist) || !existsSync(file)) return next()
      res.setHeader('Content-Type', file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript')
      createReadStream(file).pipe(res)
    })
  },
}

export default defineConfig({
  root: __dirname,
  plugins: [spcAssets],
  // HB_TEST_ROMS: a local ROM folder the test hook may fetch from. Never set in CI.
  server: {
    port: 5199,
    strictPort: true,
    fs: { allow: [repo, ...(process.env.HB_TEST_ROMS ? [process.env.HB_TEST_ROMS] : [])] },
  },
})
