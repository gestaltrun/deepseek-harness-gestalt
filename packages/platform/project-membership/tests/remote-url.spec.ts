/** Git remote normalization decisions for project binding. */

import { describe, expect, it } from 'vitest'
import { ProjectMembershipError } from '../src/errors.ts'
import { normalizeGitRemoteUrl } from '../src/remote-url.ts'

describe('normalizeGitRemoteUrl', () => {
  it('lower-cases https scheme and host while keeping the path exact and dropping one .git suffix', () => {
    expect(normalizeGitRemoteUrl('HTTPS://GitHub.COM/BeiKeJieDeLiuLangMao/DeepSeek-Harness.GIT'))
      .toBe('https://github.com/BeiKeJieDeLiuLangMao/DeepSeek-Harness')
    expect(normalizeGitRemoteUrl('https://github.com/Org/Repo.git')).toBe('https://github.com/Org/Repo')
  })

  it('maps scp-like ssh spellings onto a canonical user@host:path form without rewriting the user', () => {
    expect(normalizeGitRemoteUrl('git@github.com:Org/Repo.git')).toBe('git@github.com:Org/Repo')
    expect(normalizeGitRemoteUrl('deploy@Enterprise.Example.NET:team/repo')).toBe('deploy@enterprise.example.net:team/repo')
  })

  it('keeps a mid-path .git directory distinct from a terminal repository suffix', () => {
    expect(normalizeGitRemoteUrl('https://host.example/team/repo.git/sub'))
      .toBe('https://host.example/team/repo.git/sub')
    expect(normalizeGitRemoteUrl('git@host.example:team/repo.git/sub')).toBe('git@host.example:team/repo.git/sub')
  })

  it('tolerates redundant leading slashes on special-scheme spellings like the git CLI does', () => {
    expect(normalizeGitRemoteUrl('https:///missing-host/repo')).toBe('https://missing-host/repo')
  })

  it.each([
    '',
    '   ',
    'git@github.com',
    'git@github.com:',
    'git@github.com:.git',
    '/local/path/only',
    'ssh://git@github.com/Org/Repo',
    'https://',
    'https://host.example/',
    'file:///srv/repo',
  ])('rejects %j with INVALID_REMOTE_URL', (input) => {
    expect(() => normalizeGitRemoteUrl(input)).toThrow(ProjectMembershipError)
    try {
      normalizeGitRemoteUrl(input)
    } catch (error) {
      expect((error as ProjectMembershipError).code).toBe('INVALID_REMOTE_URL')
    }
  })
})
