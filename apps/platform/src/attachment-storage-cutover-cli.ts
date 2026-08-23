/** Complete one deployment-wide attachment authority transition. */

import pg from 'pg'
import { completeAttachmentStorageCutover } from './attachment-storage-phase.ts'
import { loadOperatedPlatformConfig } from './production-env.ts'

const config = loadOperatedPlatformConfig()
const pool = new pg.Pool(config.postgres)
try {
  await completeAttachmentStorageCutover(
    pool,
    config.environment.databaseIdentity,
    config.remoteAttachments.storage === 'postgres' ? 'bridge' : 'oss',
    config.oss.objectPrefix,
  )
} finally {
  await pool.end()
}
