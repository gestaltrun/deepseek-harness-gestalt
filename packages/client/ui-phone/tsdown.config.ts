import { clientBundle } from '../tsdown.client.ts'

export default clientBundle(
  '@deepseek-ai/dsh-client-ui-phone',
  ['lib/types/index.js', 'lib/types/invariant.js'],
  { clientSourceEntry: 'src/client/index.tsx' },
)
