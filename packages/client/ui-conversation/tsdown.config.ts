import { browserSubpath, clientBundle } from '../tsdown.client.ts'

const plugin = clientBundle('@deepseek-ai/dsh-client-ui-conversation', [
  'lib/types/index.js',
  'lib/types/invariant.js',
])
const presentation = browserSubpath(
  '@deepseek-ai/dsh-client-ui-conversation',
  ['lib/types/presentation.js'],
)

export default (input: Parameters<typeof plugin>[0]) => [
  ...plugin(input),
  ...presentation(input),
]
