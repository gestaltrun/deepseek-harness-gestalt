import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HEX = 'ab'.repeat(32)
const APSARADB_CA_BASE64 = readFileSync(
  new URL('../../../packages/platform/remote-access-http/tests/fixtures/localhost-cert.pem', import.meta.url),
).toString('base64')

/** Complete listen-process Environment used by keyless operated Platform launch tests. */
export function operatedFixtureEnv(): NodeJS.Dict<string> {
  return {
    PLATFORM_ENVIRONMENT: 'production',
    PLATFORM_ORIGIN: 'https://platform.fixture.example',
    PLATFORM_GITHUB_CLIENT_ID: 'github-client-fixture',
    PLATFORM_GITHUB_CLIENT_SECRET: 'github-secret-fixture',
    PLATFORM_GITHUB_CALLBACK: 'https://platform.fixture.example/v1/account/oauth/github/callback',
    PLATFORM_GITHUB_CREDENTIAL_REFERENCE: 'credentials://github-oauth/fixture',
    PLATFORM_POSTGRES_HOST: 'postgres.operated.fixture',
    PLATFORM_POSTGRES_USER: 'fixture',
    PLATFORM_POSTGRES_PASSWORD: 'postgres-secret-fixture',
    PLATFORM_APSARADB_CA_BASE64: APSARADB_CA_BASE64,
    PLATFORM_POSTGRES_DATABASE: 'product-entry-fixture',
    PLATFORM_IDENTITY_NAMESPACE: 'identity-fixture',
    PLATFORM_REDIS_HOST: 'redis.operated.fixture',
    PLATFORM_REDIS_USER: 'fixture',
    PLATFORM_REDIS_PASSWORD: 'redis-secret-fixture',
    PLATFORM_OSS_ENDPOINT: 'oss-cn-hangzhou-internal.aliyuncs.com',
    PLATFORM_OSS_BUCKET: 'gestalt-secret',
    PLATFORM_OSS_AUTH: 'ecs-ram-role/gestalt-vpc',
    PLATFORM_OSS_OBJECT_PREFIX: 'remote-attachments/fixture',
    PLATFORM_OSS_TIMEOUT_MS: '10000',
    PLATFORM_RELAY_REDIS_KEY_PREFIX: 'gestalt:relay:fixture',
    PLATFORM_RELAY_INSTANCE_ID: 'instance-fixture',
    PLATFORM_RELAY_CAPACITY_RETRY_AFTER_MS: '1000',
    PLATFORM_RELAY_DELIVERY_ACK_TIMEOUT_MS: '5000',
    PLATFORM_RELAY_DIRECTORY_TTL_MS: '60000',
    PLATFORM_RELAY_HEARTBEAT_TIMEOUT_MS: '45000',
    PLATFORM_RELAY_MAX_BUFFERED_CIPHERTEXT_BYTES: '1048576',
    PLATFORM_RELAY_MAX_CONNECTIONS: '10000',
    PLATFORM_RELAY_MAX_PENDING_DELIVERIES: '10000',
    PLATFORM_RELAY_MAX_PENDING_CHALLENGES: '10000',
    PLATFORM_RELAY_ATTACH_TIMEOUT_MS: '10000',
    PLATFORM_REMOTE_ATTACHMENT_MAX_BLOB_BYTES: '104857600',
    PLATFORM_REMOTE_ATTACHMENT_CAPABILITY_LIFETIME_MS: '900000',
    PLATFORM_REMOTE_ATTACHMENT_MAX_RETAINED_BLOBS: '10000',
    PLATFORM_REMOTE_ATTACHMENT_STORAGE: 'oss',
    PLATFORM_REMOTE_ATTACHMENT_SWEEP_INTERVAL_MS: '60000',
    PLATFORM_REMOTE_ATTACHMENT_CLEANUP_CONCURRENCY: '8',
    PLATFORM_TOKEN_SIGNING_KEY: HEX,
    PLATFORM_POLLING_SIGNING_KEY: HEX,
    PLATFORM_POSTGRES_SSL: 'require',
    PLATFORM_REDIS_TLS: '1',
    PLATFORM_LISTEN_HOST: '127.0.0.1',
    PORT: '0',
    PLATFORM_MEMBERSHIP_STORAGE: join(tmpdir(), 'dsh-platform-membership-fixture'),
  }
}
