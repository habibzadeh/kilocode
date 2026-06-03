/** @jsxImportSource solid-js */

import { For, Show, type Accessor, type Component } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { Icon } from "@kilocode/kilo-ui/icon"
import { formatRelativeDate } from "../src/utils/date"
import type { createCloudSessionState } from "./cloud-session-state"

interface CloudAgentSectionProps {
  state: ReturnType<typeof createCloudSessionState>
  current: Accessor<string | undefined>
  selected: Accessor<boolean>
  t: (key: string) => string
}

export const CloudAgentSection: Component<CloudAgentSectionProps> = (props) => (
  <div class="am-section">
    <button class="am-section-header am-section-toggle" onClick={() => props.state.toggle()}>
      <span class="am-section-label">
        <Icon
          name={props.state.collapsed() ? "chevron-right" : "chevron-down"}
          size="small"
          class="am-section-chevron"
        />
        {props.t("agentManager.section.cloudAgents")}
      </span>
    </button>
    <Show when={!props.state.collapsed()}>
      <div class="am-list">
        <Show
          when={props.state.status() !== "loading"}
          fallback={<div class="am-item-time">{props.t("agentManager.cloud.loading")}</div>}
        >
          <Show
            when={props.state.status() !== "error"}
            fallback={
              <div class="am-empty-state-text">
                <span>{props.state.error() || props.t("agentManager.cloud.failed")}</span>
                <Button variant="ghost" size="small" onClick={() => props.state.request()}>
                  {props.t("agentManager.cloud.retry")}
                </Button>
              </div>
            }
          >
            <Show
              when={props.state.sessions().length > 0}
              fallback={<div class="am-item-time">{props.t("agentManager.cloud.empty")}</div>}
            >
              <For each={props.state.sessions()}>
                {(item) => (
                  <button
                    class={`am-item ${item.id === props.current() && props.selected() ? "am-item-active" : ""}`}
                    data-sidebar-id={item.id}
                    onClick={() => props.state.open(item)}
                  >
                    <span class="am-item-title">{item.title || props.t("agentManager.session.untitled")}</span>
                    <span class="am-item-time">{formatRelativeDate(item.updatedAt)}</span>
                  </button>
                )}
              </For>
            </Show>
          </Show>
        </Show>
      </div>
    </Show>
  </div>
)
