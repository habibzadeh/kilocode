import { describe, expect, it } from "bun:test"
import { createCloudSessionState } from "../../webview-ui/agent-manager/cloud-session-state"
import type { SessionInfo, WebviewMessage } from "../../webview-ui/src/types/messages"

const info = (id: string, title = id): SessionInfo => ({
  id,
  title,
  createdAt: "2026-06-03T00:00:00.000Z",
  updatedAt: "2026-06-03T00:00:00.000Z",
})

function createState() {
  const sent: WebviewMessage[] = []
  const attached: SessionInfo[] = []
  const detached: string[] = []
  const selected: string[] = []
  const contexts: string[] = []
  let current: string | undefined
  let cleared = 0
  let sessions: SessionInfo[] = []
  const state = createCloudSessionState({
    session: {
      currentSessionID: () => current,
      sessions: () => sessions,
      selectSession: (id) => {
        current = id
        selected.push(id)
      },
      clearCurrentSession: () => {
        current = undefined
        cleared++
      },
      attachCloudSession: (session) => {
        sessions = [...sessions.filter((item) => item.id !== session.id), session]
        attached.push(session)
      },
      detachCloudSession: (id) => {
        current = current === id ? undefined : current
        sessions = sessions.filter((item) => item.id !== id)
        detached.push(id)
      },
    },
    postMessage: (message) => sent.push(message),
    setSelection: (selection) => contexts.push(selection),
    prepare: () => {},
  })
  return {
    state,
    sent,
    attached,
    detached,
    selected,
    contexts,
    current: () => current,
    cleared: () => cleared,
    stream: (session: SessionInfo) => {
      sessions = [...sessions.filter((item) => item.id !== session.id), session]
    },
  }
}

describe("cloud session state", () => {
  it("opens an attached session once while allowing it to be focused again", () => {
    const ctl = createState()
    const session = info("ses_a")

    ctl.state.open(session)
    ctl.state.open(session)

    expect(ctl.state.ids()).toEqual(["ses_a"])
    expect(ctl.sent).toEqual([{ type: "agentManager.openCloudSession", sessionId: "ses_a" }])
    expect(ctl.current()).toBe("ses_a")
  })

  it("closes an inactive attached session without changing the active session", () => {
    const ctl = createState()
    ctl.state.open(info("ses_a"))
    ctl.state.open(info("ses_b"))

    ctl.state.close("ses_a")

    expect(ctl.state.ids()).toEqual(["ses_b"])
    expect(ctl.current()).toBe("ses_b")
    expect(ctl.selected).toEqual(["ses_a", "ses_b"])
  })

  it("selects the adjacent attached session when the active session closes", () => {
    const ctl = createState()
    ctl.state.open(info("ses_a"))
    ctl.state.open(info("ses_b"))
    ctl.state.open(info("ses_c"))
    ctl.state.open(info("ses_b"))

    ctl.state.close("ses_b")

    expect(ctl.state.ids()).toEqual(["ses_a", "ses_c"])
    expect(ctl.current()).toBe("ses_c")
    expect(ctl.selected.at(-1)).toBe("ses_c")
  })

  it("falls back to LOCAL when the last active session closes", () => {
    const ctl = createState()
    ctl.state.open(info("ses_a"))

    ctl.state.close("ses_a")

    expect(ctl.contexts.at(-1)).toBe("local")
    expect(ctl.cleared()).toBe(1)
  })

  it("closes an attached session when the extension reports remote deletion", () => {
    const ctl = createState()
    ctl.state.open(info("ses_a"))

    ctl.state.handle({ type: "agentManager.cloudSessionDeleted", sessionId: "ses_a" })

    expect(ctl.state.ids()).toEqual([])
    expect(ctl.detached).toEqual(["ses_a"])
    expect(ctl.sent).toEqual([
      { type: "agentManager.openCloudSession", sessionId: "ses_a" },
      { type: "agentManager.closeCloudSession", sessionId: "ses_a" },
    ])
  })

  it("preserves an attached tab absent from a capped discovery refresh", () => {
    const ctl = createState()
    ctl.state.open(info("ses_attached", "old"))

    ctl.state.handle({ type: "agentManager.cloudSessions", status: "ready", sessions: [info("ses_listed")] })

    expect(ctl.state.ids()).toEqual(["ses_attached"])
    expect(ctl.state.tabs()).toEqual([info("ses_attached", "old")])
    expect(ctl.detached).toEqual([])
  })

  it("refreshes an attached tab summary when it appears in discovery", () => {
    const ctl = createState()
    ctl.state.open(info("ses_attached", "old"))

    ctl.state.handle({ type: "agentManager.cloudSessions", status: "ready", sessions: [info("ses_attached", "new")] })

    expect(ctl.state.tabs()).toEqual([info("ses_attached", "new")])
    expect(ctl.attached.at(-1)).toEqual(info("ses_attached", "new"))
  })

  it("reflects canonical streamed summary changes in attached tabs", () => {
    const ctl = createState()
    ctl.state.open(info("ses_attached", "old"))

    ctl.stream(info("ses_attached", "streamed"))

    expect(ctl.state.tabs()).toEqual([info("ses_attached", "streamed")])
  })
})
