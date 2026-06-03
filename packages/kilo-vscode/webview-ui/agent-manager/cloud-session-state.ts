import { createSignal } from "solid-js"
import type { ExtensionMessage, SessionInfo, WebviewMessage } from "../src/types/messages"
import { closeCloudTab, openCloudTab } from "./cloud-tab-state"
import { LOCAL } from "./navigate"
import { reorderTabs } from "./tab-order"

export const CLOUD = "cloud-agent"

const BLOCKED_ACTIONS = new Set([
  "sessionPrevious",
  "sessionNext",
  "showTerminal",
  "toggleDiff",
  "newTab",
  "newWorktree",
  "openWorktree",
  "runScript",
  "advancedWorktree",
  "closeWorktree",
  "newTerminal",
])

export function blocksCloudAction(action?: string) {
  return !!action && (BLOCKED_ACTIONS.has(action) || /^jumpTo[1-9]$/.test(action))
}

interface CloudSession {
  currentSessionID: () => string | undefined
  sessions: () => SessionInfo[]
  selectSession: (id: string) => void
  clearCurrentSession: () => void
  attachCloudSession: (session: SessionInfo) => void
  detachCloudSession: (id: string) => void
}

interface CloudSessionStateOptions {
  session: CloudSession
  postMessage: (message: WebviewMessage) => void
  setSelection: (selection: string) => void
  prepare: () => void
}

export function createCloudSessionState(opts: CloudSessionStateOptions) {
  const [sessions, setSessions] = createSignal<SessionInfo[]>([])
  const [status, setStatus] = createSignal<"loading" | "ready" | "error">("loading")
  const [error, setError] = createSignal<string>()
  const [collapsed, setCollapsed] = createSignal(false)
  const [ids, setIds] = createSignal<string[]>([])
  const set = () => new Set(ids())
  const tabs = () => {
    const lookup = new Map(opts.session.sessions().map((item) => [item.id, item]))
    return ids().flatMap((id) => lookup.get(id) ?? [])
  }

  const update = (items: SessionInfo[]) => {
    const lookup = new Map(items.map((item) => [item.id, item]))
    for (const id of ids()) {
      const item = lookup.get(id)
      if (item) opts.session.attachCloudSession(item)
    }
  }

  const fallback = (next: string[], selected?: string) => {
    const id = selected ?? next[0]
    if (id) {
      opts.session.selectSession(id)
      return
    }
    opts.setSelection(LOCAL)
    opts.session.clearCurrentSession()
  }

  const close = (id: string, notify = true) => {
    const previous = ids()
    const next = closeCloudTab(previous, id)
    if (next.ids === previous) return
    const active = opts.session.currentSessionID() === id
    setIds(next.ids)
    if (notify) opts.postMessage({ type: "agentManager.closeCloudSession", sessionId: id })
    opts.session.detachCloudSession(id)
    if (active) fallback(next.ids, next.selected)
  }

  const open = (info: SessionInfo) => {
    opts.prepare()
    opts.setSelection(CLOUD)
    const exists = set().has(info.id)
    setIds((prev) => openCloudTab(prev, info.id))
    opts.session.attachCloudSession(info)
    if (!exists) opts.postMessage({ type: "agentManager.openCloudSession", sessionId: info.id })
    opts.session.selectSession(info.id)
  }

  const handle = (msg: ExtensionMessage) => {
    if (msg.type === "agentManager.cloudSessions") {
      setStatus(msg.status)
      setSessions(msg.sessions)
      setError(msg.error)
      if (msg.status === "ready") update(msg.sessions)
      return
    }
    if (msg.type === "agentManager.cloudSessionDeleted") close(msg.sessionId)
  }

  return {
    sessions,
    status,
    error,
    collapsed,
    toggle: () => setCollapsed((value) => !value),
    request: () => opts.postMessage({ type: "agentManager.requestCloudSessions" }),
    ids,
    reorder: (from: string, to: string) => {
      const next = reorderTabs(ids(), from, to)
      if (next) setIds(next)
    },
    set,
    tabs,
    isTab: (id = opts.session.currentSessionID()) => !!id && set().has(id),
    open,
    close,
    handle,
  }
}
