/**
 * Model-facing Consumer of the `ctx.userQuestions` capability seam.
 * The tool pauses until a UI provider returns a human answer, then feeds that
 * answer back into the agent loop as an ordinary tool result. When
 * `to_project_member` is present the call is routed through
 * `ctx.memberQuestionSender` instead of the local provider. Runtime
 * eligibility filtering hides that parameter from unbound workspaces at
 * prompt assembly; the static schema retains it.
 *
 * @module @deepseek-ai/dsh-tool-ask-user
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import '@deepseek-ai/dsh-user-questions'
import type { MemberQuestionOrigin } from '@deepseek-ai/dsh-member-question-sender'
import {
  AskUserQuestionError,
  BACKGROUND_MAX_CODE_POINTS,
} from './errors.ts'
import { countUnicodeCodePoints, validateReferences } from './references.ts'

export { AskUserQuestionError } from './errors.ts'
export type { AskUserQuestionErrorCode } from './errors.ts'
export {
  BACKGROUND_MAX_CODE_POINTS,
  REFERENCE_REASON_MAX_CODE_POINTS,
  REFERENCES_MAX_COUNT,
} from './errors.ts'
export { countUnicodeCodePoints, validateReferences } from './references.ts'
export type { AskUserQuestionReference, ValidatedAskUserQuestionReference } from './references.ts'

export const name = 'tool-ask-user'
export const inject = ['tools', 'userQuestions']

const description = 'Ask the user a concise question when you need confirmation, a choice, or missing information before proceeding. '
  + 'Send one or more questions, each with a stable id that will be echoed in the answer. '
  + 'Pass to_project_member to route the question to one project member instead of the local user; '
  + 'routed asks require background (1 to 600 characters). '
  + 'references attaches workspace files that support the decision, locally or routed.'

/** Inputs for resolving the Decision Brief origin of one routed ask. */
export interface OriginResolverInput {
  /** Single project-member addressee from `to_project_member`. */
  toProjectMember: string
  /** Calling agent, when the tool ran from a live session. */
  agent?: Agent
}

/**
 * Resolves the Decision Brief origin of one routed ask. The composition
 * supplies project name and asker identity; the tool forwards the resolved
 * origin to the sender.
 * @param input - addressee and optional calling agent.
 * @returns the origin fields the sender encodes onto the Companion operation.
 */
export type OriginResolver = (input: OriginResolverInput) => Promise<MemberQuestionOrigin>

/**
 * Resolves the cloud project whose peer grant addresses the member. Absent,
 * the tool forwards `to_project_member` as the project id so schema-level
 * routing can be tested without a membership face. The same resolver drives
 * runtime eligibility: an unbound (undefined) result hides `to_project_member`
 * from assembled prompts.
 */
export type BoundProjectResolver = () => Promise<string | undefined>

/** Injected faces for routed asks. Local asks ignore every field. */
export interface Config {
  /**
   * Resolves Decision Brief origin fields for a routed ask. Absent, the tool
   * answers `SENDER_UNAVAILABLE` rather than inventing identity.
   */
  originResolver?: OriginResolver
  /**
   * Resolves the workspace-bound cloud project for a routed ask and for
   * runtime eligibility of `to_project_member`. Absent or resolving to
   * undefined hides the parameter from assembled prompts; a present id
   * surfaces it. Execute still forwards the addressee as the project id
   * when this resolver is absent so schema-level routing can be tested
   * without a membership face.
   */
  boundProjectResolver?: BoundProjectResolver
}

/** Schemastery configuration for the tool consumer. */
export const Config: z<Config> = z.object({
  originResolver: z.any(),
  boundProjectResolver: z.any(),
})

/** Config keys whose injected values must be callable. */
const RESOLVER_KEYS = ['originResolver', 'boundProjectResolver'] as const

/**
 * Validate the injected faces loudly for both Loader-normalized and
 * programmatic construction, so misconfiguration fails at load.
 * @param config - raw plugin config.
 * @returns the same config once every present resolver is callable.
 */
function resolveConfig(config: Config): Config {
  for (const key of RESOLVER_KEYS) {
    const value = config[key]
    if (value !== undefined && typeof value !== 'function') {
      throw new TypeError(`tool-ask-user: config.${key} must be a resolver function`)
    }
  }
  return config
}

/**
 * Register the `ask_user_question` tool on `ctx.tools`.
 * @param ctx - composition context carrying the tool registry and user-questions service.
 * @param config - injected origin and project faces used only for routed asks.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  ctx.tools.register(defineTool({
    name: 'ask_user_question',
    description,
    parameters: {
      questions: {
        type: 'array',
        required: true,
        description: 'Questions to ask the user before continuing.',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            id: { type: 'string', required: true, description: 'Stable id for this question; echoed in the answer.' },
            question: { type: 'string', required: true, description: 'The specific question to ask the user.' },
            header: {
              type: 'string',
              description: 'Optional short heading for the question, such as "Confirm" or "Choose Mode".',
            },
            options: {
              type: 'array',
              description: 'Optional choices to show the user. If you recommend one, put it first and append "(Recommended)" to that label.',
              items: {
                type: 'object',
                additionalProperties: true,
                properties: {
                  label: { type: 'string', required: true, description: 'Short user-facing option label.' },
                  description: { type: 'string', description: 'One sentence explaining the tradeoff or impact.' },
                },
              },
            },
            multi_select: {
              type: 'boolean',
              description: 'Whether the user may select more than one option. Defaults to false.',
            },
          },
        },
      },
      to_project_member: {
        type: 'string',
        description: 'Single project-member addressee. When present, the question is routed to that member instead of the local user and background is required.',
      },
      background: {
        type: 'string',
        description: 'Agent-authored Decision Brief background. Required with to_project_member; 1 to 600 characters, enforced at construction.',
      },
      references: {
        type: 'array',
        description: 'Workspace files that support the decision. Available for local and routed asks; each path must exist inside the asking session workspace.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: {
              type: 'string',
              required: true,
              description: 'Path resolved inside the asking session workspace; the file must exist.',
            },
            reason: {
              type: 'string',
              description: 'Optional one-liner (at most 100 characters) explaining why this file matters.',
            },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          answers: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                selected: { type: 'array', required: true, items: { type: 'string' } },
                custom: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const addressee = args.to_project_member
      let background: string | undefined
      if (addressee !== undefined) {
        if (args.background === undefined || args.background.length === 0) {
          throw new AskUserQuestionError(
            'BACKGROUND_REQUIRED: routed ask_user_question requires background of 1 to 600 characters',
            'BACKGROUND_REQUIRED',
          )
        }
        if (countUnicodeCodePoints(args.background) > BACKGROUND_MAX_CODE_POINTS) {
          throw new AskUserQuestionError(
            `BACKGROUND_TOO_LONG: background exceeds ${String(BACKGROUND_MAX_CODE_POINTS)} characters`,
            'BACKGROUND_TOO_LONG',
          )
        }
        background = args.background
      }
      const references = await validateReferences(args.references, exec.agent?.session.header.cwd)
      const questions = args.questions.map(question => ({
        id: question.id,
        question: question.question,
        ...question.header !== undefined ? { header: question.header } : {},
        ...question.options !== undefined ? { options: question.options } : {},
        ...question.multi_select !== undefined ? { multiSelect: question.multi_select } : {},
      }))
      if (addressee === undefined || background === undefined) {
        const result = await ctx.userQuestions.ask({
          questions,
          ...exec.agent !== undefined ? { agent: exec.agent } : {},
          signal: exec.signal,
        })
        return {
          answers: result.answers.map(answer => ({
            id: answer.id,
            selected: [...answer.selected],
            ...answer.custom !== undefined ? { custom: answer.custom } : {},
          })),
        }
      }
      const sender = ctx.get('memberQuestionSender')
      if (sender === undefined || resolved.originResolver === undefined) {
        throw new AskUserQuestionError(
          'SENDER_UNAVAILABLE: to_project_member requires ctx.memberQuestionSender and an originResolver',
          'SENDER_UNAVAILABLE',
        )
      }
      const origin = await resolved.originResolver({
        toProjectMember: addressee,
        ...exec.agent !== undefined ? { agent: exec.agent } : {},
      })
      const projectId = (await resolved.boundProjectResolver?.()) ?? addressee
      const result = await sender.send({
        toProjectMember: addressee,
        projectId,
        background,
        questions,
        references: (references ?? []).map(reference => ({
          path: reference.path,
          reason: reference.reason ?? reference.path,
        })),
        origin,
        originSessionId: String(exec.agent?.session.id ?? 'unbound-origin'),
      }, {
        ...exec.agent !== undefined ? { session: exec.agent.session } : {},
        signal: exec.signal,
      })
      if (result.outcome === 'declined') return { answers: [] }
      return {
        answers: result.answers.map(answer => ({
          id: answer.id,
          selected: [...answer.selected],
          ...answer.custom !== undefined ? { custom: answer.custom } : {},
        })),
      }
    },
  }))
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembled = await next()
    return filterAskUserQuestionSchema(assembled, resolved)
  })
}

/**
 * Hide `to_project_member` from the assembled `ask_user_question` schema when
 * the workspace is not bound to a cloud project. The static registry schema
 * is unchanged; this filter runs at prompt assembly so a later bind cannot
 * leak a stale parameter into the next request.
 * @param assembly - waterfall-authoritative prompt assembly.
 * @param config - injected project-binding face.
 * @returns the same assembly, or a clone with the routing parameter omitted.
 */
async function filterAskUserQuestionSchema(
  assembly: PromptAssembly,
  config: Config,
): Promise<PromptAssembly> {
  const bound = await resolveBoundProject(config)
  if (bound !== undefined) return assembly
  return {
    ...assembly,
    tools: assembly.tools.map((schema) => {
      if (schema.name !== 'ask_user_question') return schema
      return { ...schema, parameters: omitRoutingParameter(schema.parameters) }
    }),
  }
}

/**
 * Resolve the workspace-bound cloud project. A rejecting or absent resolver
 * is unbound — the routing parameter stays hidden rather than leaking.
 * @param config - injected project-binding face.
 * @returns the bound project id, or undefined when the workspace is unbound.
 */
async function resolveBoundProject(config: Config): Promise<string | undefined> {
  if (config.boundProjectResolver === undefined) return undefined
  try {
    return await config.boundProjectResolver()
  } catch {
    return undefined
  }
}

/**
 * Clone a JSON-schema object without the `to_project_member` property.
 * @param parameters - model-facing parameter schema of `ask_user_question`.
 * @returns the same object when the property is already absent, else a clone.
 */
function omitRoutingParameter(parameters: Record<string, unknown>): Record<string, unknown> {
  const properties = { ...(parameters.properties as Record<string, unknown> | undefined) }
  delete properties.to_project_member
  return { ...parameters, properties }
}
