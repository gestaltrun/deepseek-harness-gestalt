/** Keyless real-sender composition for the Project Members transcript. */

import type { Context } from '@deepseek-ai/cordis'
import CompanionMemberQuestionSender, {
  type MemberQuestionDeliveryPort,
} from '@deepseek-ai/dsh-member-question-sender'
import { parseInstallationId } from '@deepseek-ai/dsh-platform-account'
import type { CompanionMemberQuestionSettledResult } from '@deepseek-ai/dsh-remote-protocol'

export const name = 'project-members-memory-member-question'

/** Compose the production sender with an immediate keyless member answer. */
export async function apply(ctx: Context): Promise<void> {
  const terminals = new Map<string, CompanionMemberQuestionSettledResult>()
  const delivery: MemberQuestionDeliveryPort = {
    deliver: async (encoded) => {
      queueMicrotask(() => {
        void sender.settle(encoded.questionId, {
          outcome: 'answered',
          answers: [{ id: 'rollout', selected: ['approve'] }],
          settledByInstallationId: parseInstallationId('installation-demo-member'),
          settledByDeviceName: 'Demo Member Desktop',
          settledAt: 1_756_000_300_000,
        })
      })
    },
    publishTerminal: async (terminal) => {
      const retained = terminals.get(terminal.questionId)
      if (retained !== undefined) return { claimed: false, terminal: retained }
      terminals.set(terminal.questionId, terminal)
      return { claimed: true, terminal }
    },
    queryTerminal: async questionId => terminals.get(questionId),
  }
  const sender = new CompanionMemberQuestionSender(ctx, {
    delivery,
    presenceLookup: async () => 'online',
  })
}
