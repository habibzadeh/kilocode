import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(__dirname, "..", "..", "webview-ui", "src", "components", "chat")
const cloud = readFileSync(join(ROOT, "CloudPromptInput.tsx"), "utf8")
const local = readFileSync(join(ROOT, "PromptInput.tsx"), "utf8")

describe("CloudPromptInput restricted composer contract", () => {
  it("constrains model selection to Kilo", () => {
    expect(cloud).toContain('<ModelSelector sessionID={sid} providerID="kilo" />')
  })

  it("sends text only with the explicit selected agent override", () => {
    expect(cloud).toContain("const agent = session.selectedAgent(sid())")
    expect(cloud).toContain(
      "session.sendMessage(message, sel.providerID, sel.modelID, undefined, undefined, undefined, agent)",
    )
  })

  it("restores failed send text", () => {
    expect(cloud).toContain('message.type !== "sendMessageFailed"')
    expect(cloud).toContain("setText(message.text)")
    expect(cloud).toContain("drafts.set(key(), message.text)")
  })

  it("does not import local-only prompt features", () => {
    const forbidden = [
      "useFileMention",
      "useImageAttachments",
      "useSlashCommand",
      "useTerminalContext",
      "useGitChangesContext",
      "ThinkingSelector",
      "SpeechToText",
    ]
    for (const name of forbidden) expect(cloud).not.toContain(name)
  })
})

describe("PromptInput local composer isolation", () => {
  it("does not import or branch on cloud mode", () => {
    expect(local).not.toContain("CloudPromptInput")
    expect(local).not.toContain("props.cloud")
    expect(local).not.toContain("cloud?:")
  })
})
