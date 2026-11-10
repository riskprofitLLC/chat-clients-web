// @vitest-environment happy-dom
// Регрессия: web-logaут звал revoke для ТЕКУЩЕГО устройства — сервер
// отвечает 409 current_device by design, вызов обречён, а токен после
// «выхода» остаётся валидным. Логаут стал чисто локальным (как в Android).
import { describe, expect, it } from 'vitest'
import { AppContext } from '../src/app/context.js'
import { MemoryKv } from '../src/store/kv.js'
import { RelayApi } from '../src/net/api.js'
import { SessionInfo } from '../src/app/session.js'
import { generateIdentity } from '../src/crypto/identity.js'

describe('logout', () => {
  it('не отзывает текущее устройство и чистит сессию локально', async () => {
    const ctx = await AppContext.create(new MemoryKv())
    const identity = await generateIdentity()
    ctx.session = new SessionInfo('me', 'tok-1', 'dev-1', identity, ctx.api)

    let revokeCalls = 0
    const original = RelayApi.prototype.revokeDevice
    RelayApi.prototype.revokeDevice = async function patched(...args: Parameters<typeof original>) {
      revokeCalls++
      return original.apply(this, args)
    }
    try {
      await ctx.logout()
    } finally {
      RelayApi.prototype.revokeDevice = original
    }

    expect(revokeCalls).toBe(0)
    expect(ctx.session).toBeNull()
    expect(await ctx.secrets.token()).toBeNull()
  })
})
