import { createMemo, createResource, createSignal } from "solid-js"
import { useLocal } from "@tui/context/local"
import { useRoute } from "@tui/context/route"
import { useSync } from "@tui/context/sync"
import { map, pipe, entries, sortBy } from "remeda"
import { DialogSelect, type DialogSelectRef, type DialogSelectOption } from "@tui/ui/dialog-select"
import { useTheme } from "../context/theme"
import { TextAttributes } from "@opentui/core"
import { useSDK } from "@tui/context/sdk"

type ExposureEntry = "all" | "none" | string[] | undefined

function exposed(entry: ExposureEntry) {
  return entry !== undefined && entry !== "none"
}

function Status(props: { connected: boolean; exposure: ExposureEntry; loading: boolean }) {
  const { theme } = useTheme()
  if (props.loading) {
    return <span style={{ fg: theme.textMuted }}>⋯ Loading</span>
  }
  const connection = props.connected ? "connected" : "off"
  if (exposed(props.exposure)) {
    const detail = props.exposure === "all" ? "exposed" : `exposed: ${(props.exposure as string[]).join(",")}`
    return (
      <span style={{ fg: theme.success, attributes: TextAttributes.BOLD }}>
        ✓ {detail} · {connection}
      </span>
    )
  }
  return <span style={{ fg: theme.textMuted }}>○ hidden · {connection}</span>
}

export function DialogMcp() {
  const local = useLocal()
  const route = useRoute()
  const sync = useSync()
  const sdk = useSDK()
  const [, setRef] = createSignal<DialogSelectRef<unknown>>()
  const [loading, setLoading] = createSignal<string | null>(null)

  const sessionID = createMemo(() => (route.data.type === "session" ? route.data.sessionID : undefined))

  // effective exposure for the current session (switchboard pins + session overrides)
  const [exposure, { refetch: refetchExposure }] = createResource(sessionID, (id) => local.mcp.exposure(id), {
    initialValue: {} as Record<string, Exclude<ExposureEntry, undefined>>,
  })

  const options = createMemo(() => {
    // Track sync data and loading state to trigger re-render when they change
    const mcpData = sync.data.mcp
    const loadingMcp = loading()
    const exposureData = exposure.latest

    return pipe(
      mcpData ?? {},
      entries(),
      sortBy(([name]) => name),
      map(([name, status]) => ({
        value: name,
        title: name,
        description: status.status === "failed" ? "failed" : status.status,
        footer: (
          <Status
            connected={local.mcp.isEnabled(name)}
            exposure={exposureData?.[name]}
            loading={loadingMcp === name}
          />
        ),
        category: undefined,
      })),
    )
  })

  const actions = createMemo(() => [
    {
      command: "dialog.mcp.toggle",
      title: "show/hide (session)",
      disabled: sessionID() === undefined,
      onTrigger: async (option: DialogSelectOption<string>) => {
        const id = sessionID()
        if (!id || loading() !== null) return

        setLoading(option.value)
        try {
          const current = exposure.latest?.[option.value]
          await local.mcp.setExposure(id, option.value, !exposed(current))
          await refetchExposure()
        } catch (error) {
          console.error("Failed to change MCP exposure:", error)
        } finally {
          setLoading(null)
        }
      },
    },
    {
      command: "dialog.mcp.connect",
      title: "connect/disconnect",
      onTrigger: async (option: DialogSelectOption<string>) => {
        // Prevent toggling while an operation is already in progress
        if (loading() !== null) return

        setLoading(option.value)
        try {
          await local.mcp.toggle(option.value)
          // Refresh MCP status from server
          const status = await sdk.client.mcp.status()
          if (status.data) {
            sync.set("mcp", status.data)
          } else {
            console.error("Failed to refresh MCP status: no data returned")
          }
        } catch (error) {
          console.error("Failed to toggle MCP:", error)
        } finally {
          setLoading(null)
        }
      },
    },
  ])

  return (
    <DialogSelect
      ref={setRef}
      title="MCPs"
      options={options()}
      actions={actions()}
      onSelect={(_option) => {
        // Don't close on select, only on escape
      }}
    />
  )
}
