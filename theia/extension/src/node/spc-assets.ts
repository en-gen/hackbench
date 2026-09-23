/**
 * Serves the SPC player's two assets to the frontend.
 *
 * `@smwcentral/spc-player` is an Emscripten build that attaches itself to
 * `window.SMWCentral` when a plain <script> runs it, and then fetches
 * `spc.wasm` at runtime through its own `locateFile` hook. Neither half
 * survives being pulled through the frontend bundler as a module, so both
 * are served as files and the frontend loads them by URL. The VS Code
 * extension does the same thing with a webview resource URI
 * (src/providers/webviewUtils.ts).
 *
 * Resolved from node_modules rather than copied into the build output, so
 * the served bytes are whatever version the lockfile pins and a bump cannot
 * leave a stale copy behind.
 *
 * Only the two files are exposed, by name. A static directory mount would
 * also publish the package's HTML and CSS, which nothing here uses, and
 * would widen this to whatever a future version of the package ships.
 */
import { injectable } from '@theia/core/shared/inversify'
import { BackendApplicationContribution } from '@theia/core/lib/node'
import * as express from '@theia/core/shared/express'
import * as fs from 'fs'
import * as path from 'path'
import { SPC_ASSET_ROUTE } from '../common/music-protocol'

/** Filename to content type. The only two files this route will serve. */
const SERVED: Record<string, string> = {
  'spc.js': 'application/javascript; charset=utf-8',
  'spc.wasm': 'application/wasm',
}

@injectable()
export class SpcAssetContribution implements BackendApplicationContribution {
  configure(app: express.Application): void {
    const dist = path.dirname(require.resolve('@smwcentral/spc-player/dist/spc.js'))

    app.get(`${SPC_ASSET_ROUTE}/:file`, (req, res) => {
      const contentType = SERVED[req.params.file]
      if (!contentType) {
        res.sendStatus(404)
        return
      }
      const file = path.join(dist, req.params.file)
      if (!fs.existsSync(file)) {
        res.sendStatus(404)
        return
      }
      res.setHeader('Content-Type', contentType)
      // The bytes are immutable for a given install, and the WASM is ~1 MB.
      res.setHeader('Cache-Control', 'public, max-age=3600')
      fs.createReadStream(file).pipe(res)
    })
  }
}
