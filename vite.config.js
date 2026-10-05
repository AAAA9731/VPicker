import { defineConfig } from 'vite'
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
/**
 * 仅开发用：设置环境变量 AIC_SA_DIR（StreamingAssets 路径）后，
 * 访问 /?auto=1 即可免选择文件夹地加载，方便自动化验证。构建产物里不含此逻辑。
 */
function devGameFiles() {
  const root = process.env.AIC_SA_DIR
  return {
    name: 'dev-game-files',
    apply: 'serve',
    configureServer(server) {
      if (!root) return
      const walk = (d, out = {}) => {
        for (const f of readdirSync(d)) {
          const p = join(d, f)
          if (statSync(p).isDirectory()) walk(p, out)
          else if (/^(__ev_.*\.dat|__vp_person\.dat)$/.test(f)) out[f] = p
        }
        return out
      }
      server.middlewares.use('/__game', (req, res) => {
        const files = walk(root)
        const name = decodeURIComponent((req.url ?? '/').slice(1).split('?')[0])
        if (!name) {
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify(Object.keys(files)))
          return
        }
        const p = files[name]
        if (!p || !existsSync(p)) {
          res.statusCode = 404
          res.end()
          return
        }
        createReadStream(p).pipe(res)
      })
    },
  }
}
export default defineConfig({
  base: './',
  plugins: [devGameFiles()],
  build: { target: 'es2022' },
})
