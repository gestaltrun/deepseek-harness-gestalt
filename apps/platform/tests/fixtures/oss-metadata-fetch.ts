/** Test-process IMDSv2 responses for exercising the exact production boot entry off ECS. */

const realFetch = globalThis.fetch.bind(globalThis)

globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (url === 'http://100.100.100.200/latest/api/token') return new Response('fixture-metadata-token')
  if (url.startsWith('http://100.100.100.200/latest/meta-data/ram/security-credentials/')) {
    return new Response(JSON.stringify({
      Code: 'Success',
      AccessKeyId: 'fixture-temporary-id',
      AccessKeySecret: 'fixture-temporary-secret',
      SecurityToken: 'fixture-security-token',
    }), { headers: { 'content-type': 'application/json' } })
  }
  return await realFetch(input, init)
}
