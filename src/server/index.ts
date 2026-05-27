import 'dotenv/config'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { createServer as createViteServer } from 'vite'
import { createApiRouter } from './routes.ts'

const rootDir = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const productionMode = process.argv.includes('--production')
const port = Number(process.env.PORT ?? 5173)

async function createServer() {
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: '1mb' }))
  app.use('/api', createApiRouter())

  if (productionMode) {
    const distPath = resolve(rootDir, 'dist')
    if (!existsSync(distPath)) {
      throw new Error('Missing dist directory. Run npm run build before preview.')
    }

    app.use(express.static(distPath))
    app.get(/.*/, async (_request, response) => {
      response
        .type('html')
        .send(await readFile(resolve(distPath, 'index.html'), 'utf8'))
    })
  } else {
    const vite = await createViteServer({
      root: rootDir,
      appType: 'spa',
      server: {
        middlewareMode: true,
      },
    })
    app.use(vite.middlewares)
  }

  return app
}

const app = await createServer()
app.listen(port, () => {
  console.log(`AI Workflow Hub is running at http://localhost:${port}`)
})
