export type CloudAgentToken = {
  token: string
  expiresAt: string
  kiloFacadeUrl: string
}

export type CloudAgentSessionSummary = {
  id: string
  title: string
  createdAt: string
  updatedAt: string
}

export type CloudAgentListState =
  | { status: "loading"; sessions: [] }
  | { status: "ready"; sessions: CloudAgentSessionSummary[] }
  | { status: "error"; sessions: []; error: string }
