import { describe, expect, it } from "bun:test"
import type { GlobalEvent, KiloClient, Session } from "@kilocode/sdk/v2/client"
import { CloudAgentController, cloudDirectory } from "../../src/agent-manager/cloud-agent-controller"

function session(id = "ses_cloud"): Session {
  return {
    id,
    slug: id,
    projectID: "cloud",
    directory: cloudDirectory(id),
    title: "Cloud run",
    version: "1",
    time: { created: 1_700_000_000_000, updated: 1_700_000_100_000 },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function pending() {
  return (async function* () {
    await new Promise<void>(() => {})
  })()
}

function local(token = "secret"): KiloClient {
  return {
    kilo: {
      cloudAgent: {
        credentials: async () => ({
          data: {
            token,
            expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            kiloFacadeUrl: "https://cloud.example/kilo",
          },
        }),
      },
    },
  } as unknown as KiloClient
}

function remote(extra: Record<string, unknown> = {}): KiloClient {
  return {
    session: {
      list: async () => ({ data: [] }),
      get: async () => ({ data: session() }),
      messages: async () => ({ data: [] }),
      ...((extra.session as Record<string, unknown>) ?? {}),
    },
    global: {
      event: async () => ({ stream: pending() }),
      ...((extra.global as Record<string, unknown>) ?? {}),
    },
  } as unknown as KiloClient
}

function controller(client: KiloClient, posts: unknown[], extra: Record<string, unknown> = {}) {
  return new CloudAgentController({
    getLocalClient: local,
    post: (message) => posts.push(message),
    log: () => {},
    createClient: (() => client) as never,
    ...extra,
  })
}

function type(item: unknown) {
  return (item as { type?: string }).type
}

describe("CloudAgentController", () => {
  it("posts projected list summaries and ignores stale list completions", async () => {
    const posts: unknown[] = []
    const first = deferred<{ data: Session[] }>()
    const second = deferred<{ data: Session[] }>()
    let calls = 0
    const cloud = controller(
      remote({
        session: {
          list: () => {
            calls += 1
            return calls === 1 ? first.promise : second.promise
          },
        },
      }),
      posts,
    )
    cloud.attach()

    cloud.requestList()
    cloud.requestList()
    first.resolve({ data: [session("ses_old")] })
    second.resolve({ data: [session()] })
    await Bun.sleep(0)

    expect(posts.filter((item) => type(item) === "agentManager.cloudSessions")).toEqual([
      { type: "agentManager.cloudSessions", status: "loading", sessions: [] },
      { type: "agentManager.cloudSessions", status: "loading", sessions: [] },
      {
        type: "agentManager.cloudSessions",
        status: "ready",
        sessions: [
          {
            id: "ses_cloud",
            title: "Cloud run",
            createdAt: "2023-11-14T22:13:20.000Z",
            updatedAt: "2023-11-14T22:15:00.000Z",
          },
        ],
      },
    ])
  })

  it("does not post an in-flight list completion after detach", async () => {
    const posts: unknown[] = []
    const gate = deferred<{ data: Session[] }>()
    const cloud = controller(remote({ session: { list: () => gate.promise } }), posts)
    cloud.attach()

    cloud.requestList()
    cloud.detach()
    gate.resolve({ data: [session()] })
    await Bun.sleep(0)

    expect(posts).toEqual([{ type: "agentManager.cloudSessions", status: "loading", sessions: [] }])
  })

  it("does not create a remote client from stale credentials after panel replacement", async () => {
    const posts: unknown[] = []
    const first = deferred<{ data: unknown }>()
    const second = deferred<{ data: unknown }>()
    const tokens: string[] = []
    let calls = 0
    const cloud = new CloudAgentController({
      getLocalClient: () =>
        ({
          kilo: {
            cloudAgent: {
              credentials: () => {
                calls += 1
                return calls === 1 ? first.promise : second.promise
              },
            },
          },
        }) as unknown as KiloClient,
      post: (message) => posts.push(message),
      log: () => {},
      createClient: ((opts: { headers?: Record<string, string> }) => {
        tokens.push(opts.headers?.Authorization ?? "")
        return remote()
      }) as never,
    })
    cloud.attach()

    cloud.requestList()
    cloud.detach()
    cloud.attach()
    cloud.requestList()
    first.resolve({
      data: {
        token: "secret-old",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        kiloFacadeUrl: "https://cloud.example/kilo",
      },
    })
    second.resolve({
      data: {
        token: "secret-new",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        kiloFacadeUrl: "https://cloud.example/kilo",
      },
    })
    await Bun.sleep(0)

    expect(tokens).toEqual(["Bearer secret-new"])
    expect(posts.filter((item) => type(item) === "agentManager.cloudSessions")).toEqual([
      { type: "agentManager.cloudSessions", status: "loading", sessions: [] },
      { type: "agentManager.cloudSessions", status: "loading", sessions: [] },
      { type: "agentManager.cloudSessions", status: "ready", sessions: [] },
    ])
  })

  it("retries a stale token fetch without installing the stale remote client", async () => {
    const posts: unknown[] = []
    const first = deferred<{ data: unknown }>()
    const tokens: string[] = []
    let calls = 0
    const cloud = new CloudAgentController({
      getLocalClient: () =>
        ({
          kilo: {
            cloudAgent: {
              credentials: () => {
                calls += 1
                if (calls === 1) return first.promise
                return Promise.resolve({
                  data: {
                    token: "secret-new",
                    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
                    kiloFacadeUrl: "https://cloud.example/kilo",
                  },
                })
              },
            },
          },
        }) as unknown as KiloClient,
      post: (message) => posts.push(message),
      log: () => {},
      createClient: ((opts: { headers?: Record<string, string> }) => {
        tokens.push(opts.headers?.Authorization ?? "")
        return remote()
      }) as never,
    })
    cloud.attach()

    cloud.requestList()
    ;(cloud as unknown as { token: { clear(): void } }).token.clear()
    first.resolve({
      data: {
        token: "secret-old",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        kiloFacadeUrl: "https://cloud.example/kilo",
      },
    })
    await Bun.sleep(0)

    expect(tokens).toEqual(["Bearer secret-new"])
    expect(posts).toEqual([
      { type: "agentManager.cloudSessions", status: "loading", sessions: [] },
      { type: "agentManager.cloudSessions", status: "ready", sessions: [] },
    ])
  })

  it("registers ownership synchronously without duplicate initial transcript loading", async () => {
    const posts: unknown[] = []
    let loads = 0
    let streams = 0
    const cloud = controller(
      remote({
        session: {
          get: async () => {
            loads += 1
            return { data: session() }
          },
        },
        global: {
          event: async () => {
            streams += 1
            return { stream: pending() }
          },
        },
      }),
      posts,
    )
    cloud.attach()

    expect(cloud.handle({ type: "agentManager.openCloudSession", sessionId: "ses_cloud" })).toBe(true)
    expect(cloud.owns("ses_cloud")).toBe(true)
    await Bun.sleep(0)
    expect(streams).toBe(1)
    expect(loads).toBe(0)

    expect(cloud.handle({ type: "loadMessages", sessionID: "ses_cloud" })).toBe(true)
    await Bun.sleep(0)
    expect(loads).toBe(1)
  })

  it("starts SSE on first open and stops after the last close", async () => {
    const posts: unknown[] = []
    let signal: AbortSignal | undefined
    let streams = 0
    const cloud = controller(
      remote({
        global: {
          event: async (opts: { signal?: AbortSignal }) => {
            streams += 1
            signal = opts.signal
            return { stream: pending() }
          },
        },
      }),
      posts,
    )

    cloud.attach()
    await Bun.sleep(0)
    expect(streams).toBe(0)
    cloud.open("ses_cloud")
    cloud.open("ses_other")
    await Bun.sleep(0)
    expect(streams).toBe(1)
    cloud.close("ses_cloud")
    expect(signal?.aborted).toBe(false)
    cloud.close("ses_other")
    expect(signal?.aborted).toBe(true)
  })

  it("loads only the latest transcript request while the tab remains open", async () => {
    const posts: unknown[] = []
    const first = deferred<{ data: Session }>()
    const second = deferred<{ data: Session }>()
    let calls = 0
    const cloud = controller(
      remote({
        session: {
          get: () => {
            calls += 1
            return calls === 1 ? first.promise : second.promise
          },
        },
      }),
      posts,
    )
    cloud.attach()
    cloud.open("ses_cloud")

    cloud.handle({ type: "loadMessages", sessionID: "ses_cloud" })
    cloud.handle({ type: "loadMessages", sessionID: "ses_cloud" })
    first.resolve({ data: session("ses_old") })
    second.resolve({ data: session() })
    await Bun.sleep(0)

    expect(posts.filter((item) => type(item) === "messagesLoaded")).toHaveLength(1)
    expect(posts.filter((item) => type(item) === "sessionUpdated")).toEqual([
      {
        type: "sessionUpdated",
        session: {
          id: "ses_cloud",
          parentID: null,
          title: "Cloud run",
          createdAt: "2023-11-14T22:13:20.000Z",
          updatedAt: "2023-11-14T22:15:00.000Z",
          revert: null,
          summary: null,
        },
      },
    ])
  })

  it("hydrates an owned transcript from the cloud directory with a slimmed payload", async () => {
    const posts: unknown[] = []
    const calls: unknown[] = []
    const cloud = controller(
      remote({
        session: {
          get: async (input: unknown) => {
            calls.push(["get", input])
            return { data: session() }
          },
          messages: async (input: unknown) => {
            calls.push(["messages", input])
            return {
              data: [
                {
                  info: {
                    id: "msg_1",
                    sessionID: "ses_cloud",
                    role: "user",
                    time: { created: 1_700_000_200_000 },
                    summary: { diffs: [{ file: "src/index.ts", patch: "@@ heavy patch" }] },
                  },
                  parts: [{ id: "part_1", sessionID: "ses_cloud", messageID: "msg_1", type: "text", text: "continue" }],
                },
              ],
            }
          },
        },
      }),
      posts,
    )
    cloud.attach()
    cloud.open("ses_cloud")

    expect(cloud.handle({ type: "loadMessages", sessionID: "ses_cloud" })).toBe(true)
    await Bun.sleep(0)

    expect(calls).toEqual([
      ["get", { sessionID: "ses_cloud", directory: cloudDirectory("ses_cloud") }],
      ["messages", { sessionID: "ses_cloud", directory: cloudDirectory("ses_cloud") }],
    ])
    expect(posts).toContainEqual({
      type: "messagesLoaded",
      sessionID: "ses_cloud",
      messages: [
        {
          id: "msg_1",
          sessionID: "ses_cloud",
          role: "user",
          time: { created: 1_700_000_200_000 },
          summary: { diffs: [{ file: "src/index.ts" }] },
          parts: [{ id: "part_1", sessionID: "ses_cloud", messageID: "msg_1", type: "text", text: "continue" }],
          createdAt: "2023-11-14T22:16:40.000Z",
        },
      ],
      mode: "replace",
      hasMore: false,
    })
  })

  it("does not post an in-flight transcript completion after detach", async () => {
    const posts: unknown[] = []
    const gate = deferred<{ data: Session }>()
    const cloud = controller(remote({ session: { get: () => gate.promise } }), posts)
    cloud.attach()
    cloud.open("ses_cloud")

    cloud.handle({ type: "loadMessages", sessionID: "ses_cloud" })
    cloud.detach()
    gate.resolve({ data: session() })
    await Bun.sleep(0)

    expect(posts).toEqual([])
  })

  it("sends text-only follow-ups with the explicit Kilo model and agent", async () => {
    const posts: unknown[] = []
    const calls: unknown[] = []
    const cloud = controller(
      remote({
        session: {
          promptAsync: async (input: unknown) => {
            calls.push(input)
            return { data: undefined }
          },
        },
      }),
      posts,
    )
    cloud.attach()
    cloud.open("ses_cloud")

    expect(
      cloud.handle({
        type: "sendMessage",
        sessionID: "ses_cloud",
        messageID: "msg_followup",
        text: "continue",
        providerID: "kilo",
        modelID: "anthropic/claude-sonnet-4",
        agent: "code",
      }),
    ).toBe(true)
    await Bun.sleep(0)

    expect(calls).toEqual([
      {
        sessionID: "ses_cloud",
        directory: "/cloud-agent/sessions/ses_cloud",
        messageID: "msg_followup",
        parts: [{ type: "text", text: "continue" }],
        model: { providerID: "kilo", modelID: "anthropic/claude-sonnet-4" },
        agent: "code",
      },
    ])
  })

  it("aborts an owned session through the cloud directory", async () => {
    const posts: unknown[] = []
    const calls: unknown[] = []
    const cloud = controller(
      remote({
        session: {
          abort: async (input: unknown) => {
            calls.push(input)
            return { data: true }
          },
        },
      }),
      posts,
    )
    cloud.attach()
    cloud.open("ses_cloud")

    expect(cloud.handle({ type: "abort", sessionID: "ses_cloud" })).toBe(true)
    await Bun.sleep(0)

    expect(calls).toEqual([{ sessionID: "ses_cloud", directory: cloudDirectory("ses_cloud") }])
  })

  it("consumes local and Agent Manager mutations for owned cloud sessions", () => {
    const posts: unknown[] = []
    const cloud = controller(remote(), posts)
    cloud.attach()
    cloud.open("ses_cloud")

    expect(cloud.handle({ type: "sendCommand", sessionID: "ses_cloud", text: "/init" })).toBe(true)
    expect(cloud.handle({ type: "revertSession", sessionID: "ses_cloud" })).toBe(true)
    expect(cloud.handle({ type: "agentManager.forkSession", sessionId: "ses_cloud" })).toBe(true)
    expect(cloud.handle({ type: "agentManager.closeSession", sessionId: "ses_cloud" })).toBe(true)
    expect(cloud.owns("ses_cloud")).toBe(true)
    expect(cloud.handle({ type: "agentManager.promoteSession", sessionId: "ses_cloud" })).toBe(true)
    expect(cloud.handle({ type: "agentManager.addSessionToWorktree", sessionId: "ses_cloud" })).toBe(true)
    expect(cloud.handle({ type: "agentManager.persistSession", sessionId: "ses_cloud" })).toBe(true)
    expect(posts).toContainEqual({
      type: "sendMessageFailed",
      error: "Cloud Agent sessions do not support sendCommand",
      text: "/init",
      sessionID: "ses_cloud",
      draftID: undefined,
      messageID: undefined,
      files: undefined,
    })
    expect(posts).toContainEqual({
      type: "error",
      sessionID: "ses_cloud",
      message: "Cloud Agent sessions do not support agentManager.forkSession",
    })
  })

  it("consumes newly added owned commands by default", () => {
    const posts: unknown[] = []
    const cloud = controller(remote(), posts)
    cloud.attach()
    cloud.open("ses_cloud")

    expect(cloud.handle({ type: "futureLocalMutation", sessionID: "ses_cloud" })).toBe(true)
    expect(posts).toContainEqual({
      type: "error",
      sessionID: "ses_cloud",
      message: "Cloud Agent sessions do not support futureLocalMutation",
    })
  })

  it("recreates the remote client after stream termination before reconnect", async () => {
    const posts: unknown[] = []
    const waits: number[] = []
    let creates = 0
    let cloud!: CloudAgentController
    cloud = new CloudAgentController({
      getLocalClient: local,
      post: (message) => posts.push(message),
      log: () => {},
      createClient: (() => {
        creates += 1
        return remote({ global: { event: async () => ({ stream: (async function* () {})() }) } })
      }) as never,
      wait: async (ms) => {
        waits.push(ms)
        if (waits.length === 2) cloud.dispose()
      },
    })

    cloud.attach()
    cloud.open("ses_cloud")
    await Bun.sleep(0)
    await Bun.sleep(0)
    await Bun.sleep(0)

    expect(creates).toBe(2)
    expect(waits).toEqual([250, 500])
  })

  it("clears credentials for tagged and name-like unauthorized REST envelopes", async () => {
    for (const err of [{ _tag: "Unauthorized" }, { name: "UnauthorizedError" }]) {
      const posts: unknown[] = []
      const tokens: string[] = []
      let auth = 0
      let creates = 0
      const cloud = new CloudAgentController({
        getLocalClient: () => {
          auth += 1
          return local(`secret-${auth}`)
        },
        post: (message) => posts.push(message),
        log: () => {},
        createClient: ((opts: { headers?: Record<string, string> }) => {
          creates += 1
          tokens.push(opts.headers?.Authorization ?? "")
          return remote({
            session: {
              list: async () => {
                if (creates === 1) throw err
                return { data: [] }
              },
            },
          })
        }) as never,
      })
      cloud.attach()

      cloud.requestList()
      await Bun.sleep(0)

      expect(tokens).toEqual(["Bearer secret-1", "Bearer secret-2"])
      cloud.dispose()
    }
  })

  it("retries an unauthorized abort once with refreshed credentials", async () => {
    const posts: unknown[] = []
    const tokens: string[] = []
    let auth = 0
    let creates = 0
    const calls: unknown[] = []
    const cloud = new CloudAgentController({
      getLocalClient: () => {
        auth += 1
        return local(`secret-${auth}`)
      },
      post: (message) => posts.push(message),
      log: () => {},
      createClient: ((opts: { headers?: Record<string, string> }) => {
        creates += 1
        tokens.push(opts.headers?.Authorization ?? "")
        return remote({
          session: {
            abort: async (input: unknown) => {
              calls.push(input)
              if (creates === 1) throw { _tag: "Unauthorized" }
              return { data: true }
            },
          },
        })
      }) as never,
    })
    cloud.attach()
    cloud.open("ses_cloud")
    await Bun.sleep(0)

    expect(cloud.handle({ type: "abort", sessionID: "ses_cloud" })).toBe(true)
    await Bun.sleep(0)

    expect(tokens).toEqual(["Bearer secret-1", "Bearer secret-2"])
    expect(calls).toEqual([
      { sessionID: "ses_cloud", directory: cloudDirectory("ses_cloud") },
      { sessionID: "ses_cloud", directory: cloudDirectory("ses_cloud") },
    ])
  })

  it("clears credentials when an SSE unauthorized message ends the stream", async () => {
    const posts: unknown[] = []
    const waits: number[] = []
    const tokens: string[] = []
    let auth = 0
    let creates = 0
    let cloud!: CloudAgentController
    cloud = new CloudAgentController({
      getLocalClient: () => {
        auth += 1
        return local(`secret-${auth}`)
      },
      post: (message) => posts.push(message),
      log: () => {},
      createClient: ((opts: { headers?: Record<string, string> }) => {
        creates += 1
        tokens.push(opts.headers?.Authorization ?? "")
        return remote({
          global: {
            event: async (sse: { onSseError?: (err: unknown) => void }) => ({
              stream: (async function* () {
                if (creates === 1) sse.onSseError?.(new Error("SSE request failed with status 401 Unauthorized"))
              })(),
            }),
          },
        })
      }) as never,
      wait: async (ms) => {
        waits.push(ms)
        if (waits.length === 2) cloud.dispose()
      },
    })

    cloud.attach()
    cloud.open("ses_cloud")
    await Bun.sleep(0)
    await Bun.sleep(0)
    await Bun.sleep(0)

    expect(tokens).toEqual(["Bearer secret-1", "Bearer secret-2"])
  })

  it("forwards owned incremental parts and filters non-owned stream events", async () => {
    const posts: unknown[] = []
    const events: GlobalEvent[] = [
      {
        directory: cloudDirectory("ses_other"),
        payload: {
          id: "evt_other",
          type: "message.part.updated",
          properties: {
            part: { id: "part_other", sessionID: "ses_other", messageID: "msg_other", type: "text", text: "skip" },
          },
        },
      },
      {
        directory: cloudDirectory("ses_cloud"),
        payload: {
          id: "evt_cloud",
          type: "message.part.updated",
          properties: {
            part: { id: "part_1", sessionID: "ses_cloud", messageID: "msg_1", type: "text", text: "delta" },
          },
        },
      },
    ]
    const cloud = controller(
      remote({
        global: {
          event: async () => ({
            stream: (async function* () {
              yield events[0]!
              yield events[1]!
              await new Promise<void>(() => {})
            })(),
          }),
        },
      }),
      posts,
    )
    cloud.attach()
    cloud.open("ses_cloud")
    await Bun.sleep(0)

    expect(posts).toEqual([
      {
        type: "partUpdated",
        sessionID: "ses_cloud",
        messageID: "msg_1",
        part: { id: "part_1", sessionID: "ses_cloud", messageID: "msg_1", type: "text", text: "delta" },
      },
    ])
  })

  it("removes an SSE-deleted owned session, refreshes discovery, and stops the last stream", async () => {
    const posts: unknown[] = []
    let signal: AbortSignal | undefined
    const cloud = controller(
      remote({
        global: {
          event: async (opts: { signal?: AbortSignal }) => {
            signal = opts.signal
            return {
              stream: (async function* () {
                yield {
                  directory: cloudDirectory("ses_cloud"),
                  payload: {
                    id: "evt_deleted",
                    type: "session.deleted",
                    properties: { sessionID: "ses_cloud", info: session() },
                  },
                }
                yield {
                  directory: cloudDirectory("ses_cloud"),
                  payload: { id: "evt_stale", type: "session.updated", properties: { info: session() } },
                }
                await new Promise<void>(() => {})
              })(),
            }
          },
        },
      }),
      posts,
    )
    cloud.attach()
    cloud.open("ses_cloud")
    await Bun.sleep(0)

    expect(cloud.owns("ses_cloud")).toBe(true)
    expect(posts.slice(0, 3)).toEqual([
      { type: "agentManager.cloudSessionDeleted", sessionId: "ses_cloud" },
      { type: "sessionDeleted", sessionID: "ses_cloud" },
      { type: "agentManager.cloudSessions", status: "loading", sessions: [] },
    ])
    expect(posts.some((item) => type(item) === "sessionUpdated")).toBe(false)
    expect(signal?.aborted).toBe(true)
    expect(cloud.handle({ type: "futureQueuedMutation", sessionID: "ses_cloud" })).toBe(true)
    expect(posts).toContainEqual({
      type: "error",
      sessionID: "ses_cloud",
      message: "Cloud Agent sessions do not support futureQueuedMutation",
    })
    expect(cloud.handle({ type: "agentManager.closeCloudSession", sessionId: "ses_cloud" })).toBe(true)
    expect(cloud.owns("ses_cloud")).toBe(false)
  })

  it("surfaces unsupported remote interactions instead of forwarding shared reducer requests", async () => {
    const posts: unknown[] = []
    const cloud = controller(
      remote({
        global: {
          event: async () => ({
            stream: (async function* () {
              yield {
                directory: cloudDirectory("ses_cloud"),
                payload: {
                  id: "evt_permission",
                  type: "permission.asked",
                  properties: {
                    id: "perm_1",
                    sessionID: "ses_cloud",
                    permission: "bash",
                    patterns: [],
                    metadata: {},
                    always: [],
                  },
                },
              }
              await new Promise<void>(() => {})
            })(),
          }),
        },
      }),
      posts,
    )
    cloud.attach()
    cloud.open("ses_cloud")
    await Bun.sleep(0)

    expect(posts).toEqual([
      {
        type: "error",
        sessionID: "ses_cloud",
        message: "Cloud Agent interactive requests are not supported in VS Code yet",
      },
    ])
  })

  it("routes session.updated events whose ownership is carried by info.id", async () => {
    const posts: unknown[] = []
    const cloud = controller(
      remote({
        global: {
          event: async () => ({
            stream: (async function* () {
              yield {
                directory: cloudDirectory("ses_cloud"),
                payload: { id: "evt_update", type: "session.updated", properties: { info: session() } },
              }
              await new Promise<void>(() => {})
            })(),
          }),
        },
      }),
      posts,
    )
    cloud.attach()
    cloud.open("ses_cloud")
    await Bun.sleep(0)

    expect(posts).toContainEqual({
      type: "sessionUpdated",
      session: {
        id: "ses_cloud",
        parentID: null,
        title: "Cloud run",
        createdAt: "2023-11-14T22:13:20.000Z",
        updatedAt: "2023-11-14T22:15:00.000Z",
        revert: null,
        summary: null,
      },
    })
  })
})
