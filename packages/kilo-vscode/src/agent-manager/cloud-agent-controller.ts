import { createKiloClient, type Event, type GlobalEvent, type KiloClient, type Session } from "@kilocode/sdk/v2/client"
import { getErrorMessage, mapSSEEventToWebviewMessage, sessionToWebview } from "../kilo-provider-utils"
import { slimInfo, slimPart, slimParts } from "../kilo-provider/slim-metadata"
import { CloudAgentStaleTokenError, CloudAgentTokenManager } from "./cloud-agent-token"
import type { CloudAgentListState, CloudAgentToken } from "./cloud-agent-types"

const RECONNECT_MS = 250
const MAX_RECONNECT_MS = 5_000
const INTERACTIVE = new Set(["permission.asked", "question.asked", "suggestion.shown"])

type Message = Record<string, unknown> & { type?: string; sessionID?: string; sessionId?: string }

type Options = {
  getLocalClient: () => KiloClient | null
  post: (message: unknown) => void
  log: (...args: unknown[]) => void
  createClient?: typeof createKiloClient
  wait?: (ms: number, signal: AbortSignal) => Promise<void>
}

export function cloudDirectory(sessionID: string): string {
  return `/cloud-agent/sessions/${sessionID}`
}

export class CloudAgentController {
  private readonly token: CloudAgentTokenManager
  private readonly create: typeof createKiloClient
  private readonly wait: (ms: number, signal: AbortSignal) => Promise<void>
  private readonly openIDs = new Set<string>()
  private readonly tombstones = new Set<string>()
  private readonly loads = new Map<string, number>()
  private remote: { client: KiloClient; token: CloudAgentToken } | null = null
  private abort: AbortController | null = null
  private attached = false
  private disposed = false
  private epoch = 0
  private listEpoch = 0

  constructor(private readonly opts: Options) {
    this.token = new CloudAgentTokenManager(opts.getLocalClient)
    this.create = opts.createClient ?? createKiloClient
    this.wait = opts.wait ?? delay
  }

  attach(): void {
    if (this.disposed || this.attached) return
    this.attached = true
    this.epoch++
  }

  detach(): void {
    this.attached = false
    this.epoch++
    this.listEpoch++
    this.abort?.abort()
    this.abort = null
    this.openIDs.clear()
    this.tombstones.clear()
    this.loads.clear()
    this.reset()
  }

  dispose(): void {
    this.detach()
    this.disposed = true
  }

  requestList(): void {
    if (!this.active()) return
    const epoch = this.epoch
    const request = ++this.listEpoch
    const loading: CloudAgentListState = { status: "loading", sessions: [] }
    this.opts.post({ type: "agentManager.cloudSessions", ...loading })
    void this.list(epoch, request)
  }

  open(sessionID: string): void {
    if (!sessionID || !this.active()) return
    this.tombstones.delete(sessionID)
    this.openIDs.add(sessionID)
    this.start()
  }

  close(sessionID: string): void {
    this.openIDs.delete(sessionID)
    this.tombstones.delete(sessionID)
    this.loads.delete(sessionID)
    if (this.openIDs.size) return
    this.stopStream()
    this.remote = null
  }

  owns(sessionID?: string): boolean {
    return Boolean(sessionID && (this.openIDs.has(sessionID) || this.tombstones.has(sessionID)))
  }

  handle(message: Message): boolean {
    if (message.type === "agentManager.requestCloudSessions") {
      this.requestList()
      return true
    }
    if (message.type === "agentManager.openCloudSession") {
      if (typeof message.sessionId === "string") this.open(message.sessionId)
      return true
    }
    if (message.type === "agentManager.closeCloudSession") {
      if (typeof message.sessionId === "string") this.close(message.sessionId)
      return true
    }

    const sessionID = this.sessionID(message)
    if (!this.owns(sessionID)) return false
    if (message.type === "loadMessages") {
      void this.load(sessionID!)
      return true
    }
    if (message.type === "sendMessage") {
      void this.send(message)
      return true
    }
    if (message.type === "abort") {
      void this.stop(sessionID!)
      return true
    }
    if (message.type === "sendCommand") {
      this.reject(message, "Cloud Agent sessions do not support sendCommand")
      return true
    }
    this.opts.post({
      type: "error",
      sessionID,
      message: `Cloud Agent sessions do not support ${message.type ?? "this action"}`,
    })
    return true
  }

  private active(epoch = this.epoch): boolean {
    return this.attached && !this.disposed && this.epoch === epoch
  }

  private sessionID(message: Message): string | undefined {
    return typeof message.sessionID === "string"
      ? message.sessionID
      : typeof message.sessionId === "string"
        ? message.sessionId
        : undefined
  }

  private start(): void {
    if (!this.active() || !this.openIDs.size || this.abort) return
    const abort = new AbortController()
    const epoch = this.epoch
    this.abort = abort
    void this.consume(abort.signal, epoch).catch((err) => {
      if (this.active(epoch)) this.opts.log("stream loop failed", err)
    })
  }

  private stopStream(): void {
    this.abort?.abort()
    this.abort = null
  }

  private async client(epoch = this.epoch): Promise<KiloClient> {
    const token = await this.getToken(epoch)
    if (!this.active(epoch)) throw new StaleError()
    if (this.remote?.token === token) return this.remote.client

    const client = this.create({
      baseUrl: token.kiloFacadeUrl,
      headers: { Authorization: `Bearer ${token.token}` },
    })
    if (!this.active(epoch)) throw new StaleError()
    this.remote = { client, token }
    return client
  }

  private async getToken(epoch: number): Promise<CloudAgentToken> {
    for (const attempt of [0, 1]) {
      try {
        return await this.token.get()
      } catch (err) {
        if (!this.active(epoch) || (err instanceof CloudAgentStaleTokenError && attempt === 1)) throw new StaleError()
        if (!(err instanceof CloudAgentStaleTokenError)) throw err
      }
    }
    throw new StaleError()
  }

  private reset(): void {
    this.remote = null
    this.token.clear()
  }

  private async rest<T>(epoch: number, run: (client: KiloClient) => Promise<T>): Promise<T> {
    for (const attempt of [0, 1]) {
      try {
        return await run(await this.client(epoch))
      } catch (err) {
        if (!this.active(epoch) || err instanceof StaleError) throw err
        if (!unauthorized(err) || attempt === 1) throw err
        this.reset()
      }
    }
    throw new StaleError()
  }

  private async list(epoch: number, request: number): Promise<void> {
    try {
      const res = await this.rest(epoch, (client) => client.session.list({ limit: 100 }, { throwOnError: true }))
      if (!this.active(epoch) || this.listEpoch !== request) return
      const sessions = (res.data ?? []).map(summary)
      const ready: CloudAgentListState = { status: "ready", sessions }
      this.opts.post({ type: "agentManager.cloudSessions", ...ready })
    } catch (err) {
      if (!this.active(epoch) || this.listEpoch !== request || err instanceof StaleError) return
      this.invalidate(err)
      const error: CloudAgentListState = {
        status: "error",
        sessions: [],
        error: message(err, "Failed to load Cloud Agent sessions"),
      }
      this.opts.post({ type: "agentManager.cloudSessions", ...error })
    }
  }

  private async load(sessionID: string): Promise<void> {
    const epoch = this.epoch
    const request = (this.loads.get(sessionID) ?? 0) + 1
    this.loads.set(sessionID, request)
    try {
      const directory = cloudDirectory(sessionID)
      const [detail, transcript] = await this.rest(epoch, (client) =>
        Promise.all([
          client.session.get({ sessionID, directory }, { throwOnError: true }),
          client.session.messages({ sessionID, directory }, { throwOnError: true }),
        ]),
      )
      if (!this.current(sessionID, epoch, request)) return
      if (detail.data) this.opts.post({ type: "sessionUpdated", session: sessionToWebview(detail.data) })
      const messages = (transcript.data ?? []).map((item) => ({
        ...slimInfo(item.info),
        parts: slimParts(item.parts),
        createdAt: new Date(item.info.time.created).toISOString(),
      }))
      this.opts.post({ type: "messagesLoaded", sessionID, messages, mode: "replace", hasMore: false })
    } catch (err) {
      if (!this.current(sessionID, epoch, request) || err instanceof StaleError) return
      this.invalidate(err)
      this.opts.post({ type: "error", sessionID, message: message(err, "Failed to load Cloud Agent messages") })
    }
  }

  private current(sessionID: string, epoch: number, request: number): boolean {
    return this.active(epoch) && this.openIDs.has(sessionID) && this.loads.get(sessionID) === request
  }

  private async send(input: Message): Promise<void> {
    const epoch = this.epoch
    const sessionID = input.sessionID!
    const text = typeof input.text === "string" ? input.text : ""
    const messageID = typeof input.messageID === "string" ? input.messageID : undefined
    const draftID = typeof input.draftID === "string" ? input.draftID : undefined
    const files = Array.isArray(input.files) ? input.files : undefined
    const providerID = typeof input.providerID === "string" ? input.providerID : undefined
    const modelID = typeof input.modelID === "string" ? input.modelID : undefined
    const agent = typeof input.agent === "string" ? input.agent : undefined
    if (!text.trim() || draftID || files?.length || providerID !== "kilo" || !modelID?.trim() || !agent?.trim()) {
      this.reject(input, "Cloud Agent follow-ups require plain text, a Kilo model, and an agent")
      return
    }

    try {
      await this.rest(epoch, (client) =>
        client.session.promptAsync(
          {
            sessionID,
            directory: cloudDirectory(sessionID),
            messageID,
            parts: [{ type: "text", text }],
            model: { providerID: "kilo", modelID: modelID! },
            agent: agent!,
          },
          { throwOnError: true },
        ),
      )
    } catch (err) {
      if (!this.active(epoch) || err instanceof StaleError) return
      this.invalidate(err)
      this.reject(input, message(err, "Failed to send Cloud Agent message"))
    }
  }

  private reject(input: Message, error: string): void {
    this.opts.post({
      type: "sendMessageFailed",
      error,
      text: typeof input.text === "string" ? input.text : "",
      sessionID: this.sessionID(input),
      draftID: typeof input.draftID === "string" ? input.draftID : undefined,
      messageID: typeof input.messageID === "string" ? input.messageID : undefined,
      files: Array.isArray(input.files) ? input.files : undefined,
    })
  }

  private async stop(sessionID: string): Promise<void> {
    const epoch = this.epoch
    try {
      await this.rest(epoch, (client) =>
        client.session.abort({ sessionID, directory: cloudDirectory(sessionID) }, { throwOnError: true }),
      )
    } catch (err) {
      if (!this.active(epoch) || err instanceof StaleError) return
      this.invalidate(err)
      this.opts.post({ type: "error", sessionID, message: message(err, "Failed to abort Cloud Agent session") })
    }
  }

  private async consume(signal: AbortSignal, epoch: number): Promise<void> {
    let backoff = RECONNECT_MS
    while (!signal.aborted && this.active(epoch) && this.openIDs.size) {
      const first = await this.stream(signal, epoch).catch((err) => {
        if (this.active(epoch) && !signal.aborted) {
          this.invalidate(err)
          this.opts.log("stream failed", err)
        }
        return false
      })
      this.remote = null
      if (signal.aborted || !this.active(epoch) || !this.openIDs.size) return
      await this.wait(backoff, signal)
      if (signal.aborted || !this.active(epoch) || !this.openIDs.size) return
      await Promise.all([...this.openIDs].map((id) => this.load(id)))
      backoff = first ? RECONNECT_MS : Math.min(backoff * 2, MAX_RECONNECT_MS)
    }
  }

  private async stream(signal: AbortSignal, epoch: number): Promise<boolean> {
    const client = await this.client(epoch)
    let first = false
    let failure: unknown
    const events = await client.global.event({
      signal,
      sseMaxRetryAttempts: 1,
      onSseError: (err) => {
        failure = err
      },
    })
    for await (const item of events.stream) {
      if (signal.aborted || !this.active(epoch)) return first
      first = true
      this.event(item as GlobalEvent)
    }
    if (failure) throw failure
    return first
  }

  private event(item: GlobalEvent): void {
    const event = item.payload as Event
    const sessionID = eventSessionID(event)
    if (!sessionID || !this.openIDs.has(sessionID)) return
    if (event.type === "session.deleted") {
      this.openIDs.delete(sessionID!)
      this.tombstones.add(sessionID!)
      this.loads.delete(sessionID!)
      this.opts.post({ type: "agentManager.cloudSessionDeleted", sessionId: sessionID })
      this.opts.post({ type: "sessionDeleted", sessionID })
      this.requestList()
      if (!this.openIDs.size) this.stopStream()
      return
    }
    if (event.type === "session.created") return
    if (INTERACTIVE.has(event.type)) {
      this.opts.post({
        type: "error",
        sessionID,
        message: "Cloud Agent interactive requests are not supported in VS Code yet",
      })
      return
    }

    const output = mapSSEEventToWebviewMessage(event, sessionID)
    if (!output) return
    if (output.type === "partUpdated") {
      this.opts.post({ ...output, part: slimPart(output.part) })
      return
    }
    if (output.type === "messageCreated") {
      this.opts.post({ ...output, message: slimInfo(output.message) })
      return
    }
    this.opts.post(output)
  }

  private invalidate(err: unknown): void {
    if (!unauthorized(err)) return
    this.reset()
  }
}

class StaleError extends Error {}

function summary(session: Session) {
  const value = sessionToWebview(session)
  return { id: value.id, title: value.title, createdAt: value.createdAt, updatedAt: value.updatedAt }
}

function eventSessionID(event: Event): string | undefined {
  if (!("properties" in event) || !event.properties || typeof event.properties !== "object") return
  if ("sessionID" in event.properties && typeof event.properties.sessionID === "string")
    return event.properties.sessionID
  if ("part" in event.properties) {
    const part = event.properties.part
    if (part && typeof part === "object" && "sessionID" in part && typeof part.sessionID === "string")
      return part.sessionID
  }
  if ("info" in event.properties) {
    const info = event.properties.info
    if (info && typeof info === "object" && "sessionID" in info && typeof info.sessionID === "string")
      return info.sessionID
    if (info && typeof info === "object" && "id" in info && typeof info.id === "string") return info.id
  }
}

function unauthorized(err: unknown): boolean {
  if (typeof err === "string") return statusText(err)
  if (!(err instanceof Object)) return false
  const obj = err as Record<string, unknown>
  if (obj.status === 401) return true
  if (obj.statusCode === 401) return true
  if (obj.response instanceof Response && obj.response.status === 401) return true
  for (const key of ["_tag", "name", "message"] as const) {
    if (typeof obj[key] === "string" && statusText(obj[key])) return true
  }
  if (unauthorized(obj.error)) return true
  return false
}

function statusText(value: string): boolean {
  return /\b401\b|unauthori[sz]ed/i.test(value)
}

function message(err: unknown, fallback: string): string {
  return getErrorMessage(err) || fallback
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}
