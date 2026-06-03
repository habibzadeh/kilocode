import { describe, expect, it } from "bun:test"
import type { KiloClient } from "@kilocode/sdk/v2/client"
import { CloudAgentStaleTokenError, CloudAgentTokenManager } from "../../src/agent-manager/cloud-agent-token"

const token = {
  token: "secret",
  expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  kiloFacadeUrl: "https://cloud.example/kilo",
}

function client(fetch: () => Promise<{ data?: unknown; error?: unknown }>): KiloClient {
  return {
    kilo: { cloudAgent: { credentials: fetch } },
  } as unknown as KiloClient
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe("CloudAgentTokenManager", () => {
  it("deduplicates concurrent localhost credential fetches and caches fresh envelopes", async () => {
    let calls = 0
    const manager = new CloudAgentTokenManager(() =>
      client(async () => {
        calls += 1
        return { data: token }
      }),
    )

    const [left, right] = await Promise.all([manager.get(), manager.get()])

    expect(left).toEqual(token)
    expect(right).toBe(left)
    expect(await manager.get()).toBe(left)
    expect(calls).toBe(1)
  })

  it("clear drops the cached token so the next request refetches", async () => {
    let calls = 0
    const manager = new CloudAgentTokenManager(() =>
      client(async () => {
        calls += 1
        return { data: { ...token, token: `secret-${calls}` } }
      }),
    )

    expect((await manager.get()).token).toBe("secret-1")
    manager.clear()
    expect((await manager.get()).token).toBe("secret-2")
  })

  it("rejects and does not recache an in-flight envelope cleared before completion", async () => {
    let calls = 0
    const gate = deferred<{ data: unknown }>()
    const manager = new CloudAgentTokenManager(() =>
      client(async () => {
        calls += 1
        if (calls === 1) return gate.promise
        return { data: { ...token, token: "secret-2" } }
      }),
    )

    const stale = manager.get()
    manager.clear()
    gate.resolve({ data: { ...token, token: "secret-1" } })
    await expect(stale).rejects.toBeInstanceOf(CloudAgentStaleTokenError)
    expect((await manager.get()).token).toBe("secret-2")
    expect(calls).toBe(2)
  })

  it("refetches credentials inside the five-minute freshness buffer", async () => {
    let calls = 0
    const manager = new CloudAgentTokenManager(() =>
      client(async () => {
        calls += 1
        return {
          data: {
            ...token,
            token: `secret-${calls}`,
            expiresAt: new Date(Date.now() + (calls === 1 ? 4 : 60) * 60 * 1000).toISOString(),
          },
        }
      }),
    )

    expect((await manager.get()).token).toBe("secret-1")
    expect((await manager.get()).token).toBe("secret-2")
    expect(calls).toBe(2)
  })

  it("applies a cooldown after failed localhost credential fetches", async () => {
    let calls = 0
    const manager = new CloudAgentTokenManager(() =>
      client(async () => {
        calls += 1
        return { error: "signed out" }
      }),
    )

    await expect(manager.get()).rejects.toThrow("Cloud Agent credentials fetch failed: signed out")
    await expect(manager.get()).rejects.toThrow("Cloud Agent token fetch on cooldown")
    expect(calls).toBe(1)
  })
})
