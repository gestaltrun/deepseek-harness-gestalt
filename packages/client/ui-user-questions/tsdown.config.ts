import { browserSubpath, clientBundle } from '../tsdown.client.ts'

const plugin = clientBundle('@deepseek-ai/dsh-client-ui-user-questions', [
  'lib/types/index.js',
  'lib/types/invariant.js',
])
const presentation = browserSubpath(
  '@deepseek-ai/dsh-client-ui-user-questions',
  ['lib/types/presentation.js'],
)

export default (input: Parameters<typeof plugin>[0]) => [
  ...plugin(input),
  ...presentation(input),
]
