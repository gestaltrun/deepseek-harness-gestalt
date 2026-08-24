import { browserSubpath, clientBundle } from '../tsdown.client.ts'

const plugin = clientBundle(
  '@deepseek-ai/dsh-client-ui-theme',
  ['lib/types/index.js', 'lib/types/invariant.js'],
)
const styles = browserSubpath(
  '@deepseek-ai/dsh-client-ui-theme',
  ['lib/types/client/styles.js'],
)

export default (input: Parameters<typeof plugin>[0]) => [
  ...plugin(input),
  ...styles(input),
]
