/**
 * Browser-trust fence for phone stream routes, shared with the `/api` Host
 * fence through `@deepseek-ai/dsh-request-trust`. Capture URLs add a
 * loopback-only check on top of this fence.
 * @module @deepseek-ai/dsh-phone-stream/trust
 */

export { isLoopbackApiRequest, isLoopbackHostname, isTrustedApiRequest } from '@deepseek-ai/dsh-request-trust'
