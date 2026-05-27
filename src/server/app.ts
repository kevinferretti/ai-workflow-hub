import express from 'express'
import { createApiRouter, type CreateApiRouterOptions } from './routes.ts'

export function createApiApp(options: CreateApiRouterOptions = {}) {
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: '1mb' }))
  app.use('/api', createApiRouter(options))
  return app
}
