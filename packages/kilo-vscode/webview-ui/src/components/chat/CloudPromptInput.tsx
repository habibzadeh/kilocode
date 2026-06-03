import { type Component, createEffect, createSignal, on, onCleanup } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { Tooltip } from "@kilocode/kilo-ui/tooltip"
import { useSession } from "../../context/session"
import { useServer } from "../../context/server"
import { useLanguage } from "../../context/language"
import { useVSCode } from "../../context/vscode"
import { ModelSelector } from "../shared/ModelSelector"
import { ModeSwitcher } from "../shared/ModeSwitcher"

const drafts = new Map<string, string>()

interface CloudPromptInputProps {
  boxId?: string
}

export const CloudPromptInput: Component<CloudPromptInputProps> = (props) => {
  const session = useSession()
  const server = useServer()
  const language = useLanguage()
  const vscode = useVSCode()
  const sid = () => session.currentSessionID()
  const key = () => `${props.boxId ?? "prompt:cloud"}:${sid() ?? "new"}`
  const [text, setText] = createSignal("")
  let textareaRef: HTMLTextAreaElement | undefined

  const resize = () => {
    if (!textareaRef) return
    textareaRef.style.height = "auto"
    textareaRef.style.height = `${Math.min(textareaRef.scrollHeight, 200)}px`
  }

  createEffect(
    on(key, (next, prev) => {
      if (prev !== undefined && prev !== next) {
        const draft = text()
        if (draft) drafts.set(prev, draft)
        else drafts.delete(prev)
      }
      const draft = drafts.get(next) ?? ""
      setText(draft)
      if (!textareaRef) return
      textareaRef.value = draft
      resize()
    }),
  )

  const busy = () => session.status() === "busy"
  const canSend = () => {
    const sel = session.selected(sid())
    return (
      server.isConnected() &&
      !!text().trim() &&
      sel?.providerID === "kilo" &&
      !!sel.modelID &&
      !!session.selectedAgent(sid())
    )
  }

  const send = () => {
    if (!canSend()) return
    const message = text().trim()
    const sel = session.selected(sid())!
    const agent = session.selectedAgent(sid())
    session.sendMessage(message, sel.providerID, sel.modelID, undefined, undefined, undefined, agent)
    drafts.delete(key())
    setText("")
    if (textareaRef) textareaRef.style.height = "auto"
  }

  const unsubscribe = vscode.onMessage((message) => {
    if (message.type !== "sendMessageFailed" || message.sessionID !== sid() || text()) return
    setText(message.text)
    if (message.text) drafts.set(key(), message.text)
    queueMicrotask(resize)
  })
  onCleanup(unsubscribe)

  const input = (event: InputEvent) => {
    setText((event.target as HTMLTextAreaElement).value)
    resize()
  }

  const keydown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && busy()) {
      event.preventDefault()
      event.stopPropagation()
      session.abort()
      return
    }
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return
    event.preventDefault()
    send()
  }

  return (
    <div class="prompt-input-container">
      <div class="prompt-input-wrapper">
        <div class="prompt-input-ghost-wrapper">
          <div class="prompt-input-highlight-overlay" aria-hidden="true">
            <span>{text()}</span>
            {text().endsWith("\n") ? <br /> : null}
          </div>
          <textarea
            ref={textareaRef}
            class="prompt-input"
            classList={{ "prompt-input--disabled": !server.isConnected() }}
            placeholder={language.t("prompt.placeholder.default")}
            value={text()}
            onInput={input}
            onKeyDown={keydown}
            aria-disabled={!server.isConnected()}
            rows={1}
          />
        </div>
      </div>
      <div class="prompt-input-hint">
        <div class="prompt-input-hint-selectors">
          <ModeSwitcher sessionID={sid} />
          <ModelSelector sessionID={sid} providerID="kilo" />
        </div>
        <div class="prompt-input-hint-actions">
          {busy() ? (
            <Tooltip value={language.t("prompt.action.stop")} placement="top">
              <Button
                variant="ghost"
                size="small"
                onClick={() => session.abort()}
                aria-label={language.t("prompt.action.stop")}
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                  <rect x="3" y="3" width="10" height="10" rx="1" />
                </svg>
              </Button>
            </Tooltip>
          ) : (
            <Tooltip value={language.t("prompt.action.send")} placement="top">
              <Button
                variant="ghost"
                size="small"
                onClick={send}
                aria-disabled={!canSend()}
                aria-label={language.t("prompt.action.send")}
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M1.5 1.5L14.5 8L1.5 14.5V9L10 8L1.5 7V1.5Z" />
                </svg>
              </Button>
            </Tooltip>
          )}
        </div>
      </div>
    </div>
  )
}
