/** Deployment preflight for the operated attachment-object lifecycle rule. */

import { ensureEcsRamRoleOssLifecycle } from './oss-client.ts'

await ensureEcsRamRoleOssLifecycle({
  endpoint: process.env.PLATFORM_OSS_ENDPOINT ?? '',
  bucket: process.env.PLATFORM_OSS_BUCKET ?? '',
  auth: process.env.PLATFORM_OSS_AUTH ?? '',
  objectPrefix: process.env.PLATFORM_OSS_OBJECT_PREFIX ?? '',
  timeoutMs: Number(process.env.PLATFORM_OSS_TIMEOUT_MS),
})
