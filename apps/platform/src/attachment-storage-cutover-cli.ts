/** Complete one deployment-wide attachment authority transition. */

import pg from 'pg'
import { completeAttachmentStorageCutover } from './attachment-storage-phase.ts'
import { PostgresPersonalPairingAuthorityStore } from './postgres-pairing-store.ts'
import { loadOperatedPlatformConfig } from './production-env.ts'

const config = loadOperatedPlatformConfig()
const pool = new pg.Pool(config.postgres)
try {
  const pairings = new PostgresPersonalPairingAuthorityStore(config.environment.databaseIdentity, pool)
  await pairings.migrate()
  await completeAttachmentStorageCutover(
    pool,
    config.environment.databaseIdentity,
    config.remoteAttachments.storage === 'postgres' ? 'bridge' : 'oss',
    config.oss.objectPrefix,
    {
      maxBlobBytes: config.remoteAttachments.maxBlobBytes,
      quotaCleanup: {
        release: reservationId => pairings.runPairingTransaction((state) => {
          state.blobs.delete(reservationId)
          return Promise.resolve()
        }),
      },
    },
  )
} finally {
  await pool.end()
}
