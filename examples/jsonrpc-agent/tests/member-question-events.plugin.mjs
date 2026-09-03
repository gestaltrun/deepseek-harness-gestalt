/** SDK snapshot fixture for ordinary ignorable member-question Session events. */
export const inject = ['agents', 'sessions']

export function apply(ctx) {
  const injected = new WeakSet()
  ctx.root.on('agent/pre-step', ({ agent }, next) => {
    const session = agent.session
    if (session.header.parentSession !== undefined || injected.has(session)) return next()
    injected.add(session)
    session.append('member-question/received', {
      questionId: 'sdk-member-question',
      projectId: 'sdk-project',
      originSessionId: 'sdk-origin-session',
      arrivedAt: 100,
      expiresAt: 200,
      origin: {
        projectName: 'SDK Project',
        originSessionTitle: 'SDK Origin',
        askerAccountId: 'sdk-account',
        askerRole: 'member',
        askerDisplayName: 'SDK Member',
        askerAvatarUrl: '',
      },
      background: 'SDK event projection.',
      questions: [{ id: 'decision', question: 'Proceed?' }],
      references: [{ path: 'README.md', reason: 'SDK fixture' }],
    }, { ignorable: true })
    session.append('member-question/settled', {
      type: 'member-question-settled',
      operationId: 'sdk-operation',
      questionId: 'sdk-member-question',
      outcome: 'declined',
      settledByInstallationId: 'sdk-installation',
      settledByDeviceName: 'SDK Device',
      settledAt: 150,
    }, { ignorable: true })
    return next()
  })
}
