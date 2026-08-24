import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const driver = fileURLToPath(new URL('./fixtures/driver.ts', import.meta.url))
const config = fileURLToPath(new URL('../cordis.yml', import.meta.url))
const tsconfig = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))

describe('Platform Account keyless assembled lifecycle', () => {
  it('boots the Loader, logs in through two instances, and signs out this installation', async () => {
    const result = await runLoaderSmoke({
      label: 'platform-account-keyless',
      tempDirPrefix: 'platform-account-keyless-',
      binScript: driver,
      libBinScript: driver,
      configPath: config,
      tsconfigPath: tsconfig,
    })
    expect(result.stderr).toBe('')
    expect(result.stdout).toMatchInlineSnapshot(`
      "PRIVACY zh+en before authorization
      NOTICE zh=Platform 会保存 GitHub 数字 ID、公开登录名与头像，以及安装和配对元数据。原始 IP 日志最多保留 7 天，非内容安全事件最多保留 30 天；加密附件只在传输所需的短期内保留。首个版本不提供账号删除；退出登录只撤销当前安装，不删除个人配对。
      NOTICE en=Platform stores the numeric GitHub id, public login and avatar, plus installation and pairing metadata. Raw IP logs are retained for at most 7 days, content-free security events for at most 30 days, and encrypted attachment blobs only for the short transfer lifetime. The first version does not provide account deletion; signing out revokes only this installation and does not delete Personal Pairings.
      AUTHORIZE system-browser=https://github.com scope=none pkce=S256
      ACCOUNT githubId=13994321 login=octocat
      SESSION accessMinutes=15 refreshDays=30
      SIGN_OUT crossInstanceClosed=true local=idle
      "
    `)
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
