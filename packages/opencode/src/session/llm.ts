import { Provider } from "@/provider/provider"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import * as Log from "@opencode-ai/core/util/log"
import { Context, Effect, Layer } from "effect"
import * as Stream from "effect/Stream"
import { streamText, wrapLanguageModel, type ModelMessage, type Tool } from "ai"
import type { LLMEvent } from "@opencode-ai/llm"
import { LLMClient, RequestExecutor, WebSocketExecutor } from "@opencode-ai/llm/route"
import type { LLMClientService } from "@opencode-ai/llm/route"
import { GitLabWorkflowLanguageModel } from "gitlab-ai-provider"
import { ProviderTransform } from "@/provider/transform"
import { Config } from "@/config/config"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "./message-v2"
import { Plugin } from "@/plugin"
import { Permission } from "@/permission"
import { PermissionID } from "@/permission/schema"
import { Bus } from "@/bus"
import { Wildcard } from "@/util/wildcard"
import { SessionID } from "@/session/schema"
import { Auth } from "@/auth"
import { EffectBridge } from "@/effect/bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import * as Option from "effect/Option"
import * as OtelTracer from "@effect/opentelemetry/Tracer"
import { LLMAISDK } from "./llm/ai-sdk"
import { LLMNativeRuntime } from "./llm/native-runtime"
import { LLMRequestPrep } from "./llm/request"

const log = Log.create({ service: "llm" })
export const OUTPUT_TOKEN_MAX = ProviderTransform.OUTPUT_TOKEN_MAX

export type StreamInput = {
  user: MessageV2.User
  sessionID: string
  parentSessionID?: string
  model: Provider.Model
  agent: Agent.Info
  permission?: Permission.Ruleset
  system: string[]
  messages: ModelMessage[]
  small?: boolean
  tools: Record<string, Tool>
  retries?: number
  toolChoice?: "auto" | "required" | "none"
}

export type StreamRequest = StreamInput & {
  abort: AbortSignal
}

export interface Interface {
  readonly stream: (input: StreamInput) => Stream.Stream<LLMEvent, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/LLM") {}

export const use = serviceUse(Service)

const live: Layer.Layer<
  Service,
  never,
  | Auth.Service
  | Config.Service
  | Provider.Service
  | Plugin.Service
  | Permission.Service
  | LLMClientService
  | RuntimeFlags.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const config = yield* Config.Service
    const provider = yield* Provider.Service
    const plugin = yield* Plugin.Service
    const perm = yield* Permission.Service
    const llmClient = yield* LLMClient.Service
    const flags = yield* RuntimeFlags.Service

    const run = Effect.fn("LLM.run")(function* (input: StreamRequest) {
      const l = log
        .clone()
        .tag("providerID", input.model.providerID)
        .tag("modelID", input.model.id)
        .tag("session.id", input.sessionID)
        .tag("small", (input.small ?? false).toString())
        .tag("agent", input.agent.name)
        .tag("mode", input.agent.mode)
      l.info("stream", {
        modelID: input.model.id,
        providerID: input.model.providerID,
      })

      const [language, cfg, item, info] = yield* Effect.all(
        [
          provider.getLanguage(input.model),
          config.get(),
          provider.getProvider(input.model.providerID),
          auth.get(input.model.providerID),
        ],
        { concurrency: "unbounded" },
      )

      const isWorkflow = language instanceof GitLabWorkflowLanguageModel
      const prepared = yield* LLMRequestPrep.prepare({
        ...input,
        provider: item,
        auth: info,
        plugin,
        flags,
        isWorkflow,
      })

      // Wire up toolExecutor for DWS workflow models so that tool calls
      // from the workflow service are executed via opencode's tool system
      // and results sent back over the WebSocket.
      if (language instanceof GitLabWorkflowLanguageModel) {
        const workflowModel = language as GitLabWorkflowLanguageModel & {
          sessionID?: string
          sessionPreapprovedTools?: string[]
          approvalHandler?: (approvalTools: { name: string; args: string }[]) => Promise<{ approved: boolean }>
        }
        workflowModel.sessionID = input.sessionID
        workflowModel.systemPrompt = prepared.system.join("\n")
        workflowModel.toolExecutor = async (toolName, argsJson, _requestID) => {
          const t = prepared.tools[toolName]
          if (!t || !t.execute) {
            return { result: "", error: `Unknown tool: ${toolName}` }
          }
          try {
            const result = await t.execute!(JSON.parse(argsJson), {
              toolCallId: _requestID,
              messages: input.messages,
              abortSignal: input.abort,
            })
            const output = typeof result === "string" ? result : (result?.output ?? JSON.stringify(result))
            return {
              result: output,
              metadata: typeof result === "object" ? result?.metadata : undefined,
              title: typeof result === "object" ? result?.title : undefined,
            }
          } catch (e: any) {
            return { result: "", error: e.message ?? String(e) }
          }
        }

        const ruleset = Permission.merge(input.agent.permission ?? [], input.permission ?? [])
        workflowModel.sessionPreapprovedTools = Object.keys(prepared.tools).filter((name) => {
          const match = ruleset.findLast((rule) => Wildcard.match(name, rule.permission))
          return !match || match.action !== "ask"
        })

        const bridge = yield* EffectBridge.make()
        const approvedToolsForSession = new Set<string>()
        workflowModel.approvalHandler = bridge.bind(async (approvalTools) => {
          const uniqueNames = [...new Set(approvalTools.map((t: { name: string }) => t.name))] as string[]
          // Auto-approve tools that were already approved in this session
          // (prevents infinite approval loops for server-side MCP tools)
          if (uniqueNames.every((name) => approvedToolsForSession.has(name))) {
            return { approved: true }
          }

          const id = PermissionID.ascending()
          let unsub: (() => void) | undefined
          try {
            unsub = Bus.subscribe(Permission.Event.Replied, (evt) => {
              if (evt.properties.requestID === id) void evt.properties.reply
            })
            const toolPatterns = approvalTools.map((t: { name: string; args: string }) => {
              try {
                const parsed = JSON.parse(t.args) as Record<string, unknown>
                const title = (parsed?.title ?? parsed?.name ?? "") as string
                return title ? `${t.name}: ${title}` : t.name
              } catch {
                return t.name
              }
            })
            const uniquePatterns = [...new Set(toolPatterns)] as string[]
            await bridge.promise(
              perm.ask({
                id,
                sessionID: SessionID.make(input.sessionID),
                permission: "workflow_tool_approval",
                patterns: uniquePatterns,
                metadata: { tools: approvalTools },
                always: uniquePatterns,
                ruleset: [],
              }),
            )
            for (const name of uniqueNames) approvedToolsForSession.add(name)
            workflowModel.sessionPreapprovedTools = [...(workflowModel.sessionPreapprovedTools ?? []), ...uniqueNames]
            return { approved: true }
          } catch {
            return { approved: false }
          } finally {
            unsub?.()
          }
        })
      }

      const tracer = cfg.experimental?.openTelemetry
        ? Option.getOrUndefined(yield* Effect.serviceOption(OtelTracer.OtelTracer))
        : undefined
      const telemetryTracer = tracer
        ? new Proxy(tracer, {
            get(target, prop, receiver) {
              if (prop !== "startSpan") return Reflect.get(target, prop, receiver)
              return (...args: Parameters<typeof target.startSpan>) => {
                const span = target.startSpan(...args)
                span.setAttribute("session.id", input.sessionID)
                return span
              }
            },
          })
        : undefined

      // Runtime seam: native is an opt-in adapter over @opencode-ai/llm. It
      // either returns a ready LLMEvent stream or a concrete fallback reason.
      if (flags.experimentalNativeLlm) {
        const native = LLMNativeRuntime.stream({
          model: input.model,
          provider: item,
          auth: info,
          llmClient,
          messages: prepared.messages,
          tools: prepared.tools,
          toolChoice: input.toolChoice,
          temperature: prepared.params.temperature,
          topP: prepared.params.topP,
          topK: prepared.params.topK,
          maxOutputTokens: prepared.params.maxOutputTokens,
          providerOptions: prepared.params.options,
          headers: prepared.headers,
          abort: input.abort,
        })
        if (native.type === "supported") {
          yield* Effect.logInfo("llm runtime selected").pipe(
            Effect.annotateLogs({
              "llm.runtime": "native",
              "llm.provider": input.model.providerID,
              "llm.model": input.model.id,
            }),
          )
          return {
            type: "native" as const,
            stream: native.stream,
          }
        }
        yield* Effect.logInfo("llm runtime selected").pipe(
          Effect.annotateLogs({
            "llm.runtime": "ai-sdk",
            "llm.provider": input.model.providerID,
            "llm.model": input.model.id,
            "llm.native_unsupported_reason": native.reason,
          }),
        )
        l.info("native runtime unavailable; falling back to ai-sdk", { reason: native.reason })
      }

      yield* Effect.logInfo("llm runtime selected").pipe(
        Effect.annotateLogs({
          "llm.runtime": "ai-sdk",
          "llm.provider": input.model.providerID,
          "llm.model": input.model.id,
        }),
      )

      const debugSse =
        process.env.OPENCODE_LLM_DEBUG_SSE === "1" ||
        process.env.OPENCODE_LLM_DEBUG_SSE === "true" ||
        process.env.OPENCODE_LLM_DEBUG_SSE === "yes"

      const lastChunk = { at: Date.now(), type: "(none)" }
      const chunkCounts: Record<string, number> = {}

      // Default runtime path: AI SDK owns provider execution and tool dispatch;
      // LLMAISDK.toLLMEvents below normalizes fullStream parts for the processor.
      return {
        type: "ai-sdk" as const,
        result: streamText({
          includeRawChunks: debugSse,
          onChunk: debugSse
            ? ({ chunk }) => {
                const now = Date.now()
                const idleMs = now - lastChunk.at
                lastChunk.at = now
                lastChunk.type = chunk.type
                chunkCounts[chunk.type] = (chunkCounts[chunk.type] ?? 0) + 1

                if (chunk.type !== "raw") return
                const raw = chunk.rawValue
                if (!raw || typeof raw !== "object" || !("type" in raw)) return

                const rawType = (raw as Record<string, unknown>).type
                if (typeof rawType !== "string") return

                // Logging every delta would explode log volume; keep this focused on state transitions.
                if (rawType.endsWith(".delta")) return
                if (rawType.endsWith(".added")) return
                if (rawType.endsWith(".done")) return

                l.info("sse", {
                  kind: "raw",
                  type: rawType,
                  idleMs,
                  chunks: chunkCounts,
                })
              }
            : undefined,
          onAbort: debugSse
            ? ({ steps }) => {
                l.info("sse", {
                  kind: "abort",
                  steps: steps.length,
                  lastChunkType: lastChunk.type,
                  idleMs: Date.now() - lastChunk.at,
                  chunks: chunkCounts,
                })
              }
            : undefined,
          experimental_onStepStart: debugSse
            ? (event) => {
                l.info("sse", {
                  kind: "step-start",
                  step: event.stepNumber,
                  model: event.model,
                  messages: event.messages.length,
                  tools: event.tools ? Object.keys(event.tools).length : 0,
                  activeTools: event.activeTools?.length,
                })
              }
            : undefined,
          onFinish: debugSse
            ? ({ stepNumber, finishReason, rawFinishReason, totalUsage, steps }) => {
                l.info("sse", {
                  kind: "finish",
                  step: stepNumber,
                  finishReason,
                  rawFinishReason,
                  steps: steps.length,
                  totalUsage,
                  idleMs: Date.now() - lastChunk.at,
                  lastChunkType: lastChunk.type,
                  chunks: chunkCounts,
                })
              }
            : undefined,
          onStepFinish: debugSse
            ? (stepResult) => {
                l.info("sse", {
                  kind: "step-finish",
                  step: stepResult.stepNumber,
                  finishReason: stepResult.finishReason,
                  rawFinishReason: stepResult.rawFinishReason,
                  idleMs: Date.now() - lastChunk.at,
                  lastChunkType: lastChunk.type,
                  chunks: chunkCounts,
                })
              }
            : undefined,
          onError(error) {
            l.error("stream error", {
              error,
              ...(debugSse
                ? {
                    idleMs: Date.now() - lastChunk.at,
                    lastChunkType: lastChunk.type,
                    chunks: chunkCounts,
                  }
                : {}),
            })
          },
          async experimental_repairToolCall(failed) {
            const lower = failed.toolCall.toolName.toLowerCase()
            if (lower !== failed.toolCall.toolName && prepared.tools[lower]) {
              l.info("repairing tool call", {
                tool: failed.toolCall.toolName,
                repaired: lower,
              })
              return {
                ...failed.toolCall,
                toolName: lower,
              }
            }
            return {
              ...failed.toolCall,
              input: JSON.stringify({
                tool: failed.toolCall.toolName,
                error: failed.error.message,
              }),
              toolName: "invalid",
            }
          },
          temperature: prepared.params.temperature,
          topP: prepared.params.topP,
          topK: prepared.params.topK,
          providerOptions: ProviderTransform.providerOptions(input.model, prepared.params.options),
          activeTools: Object.keys(prepared.tools).filter((x) => x !== "invalid"),
          tools: prepared.tools,
          toolChoice: input.toolChoice,
          maxOutputTokens: prepared.params.maxOutputTokens,
          abortSignal: input.abort,
          headers: prepared.headers,
          maxRetries: input.retries ?? 0,
          messages: prepared.messages,
          model: wrapLanguageModel({
            model: language,
            middleware: [
              {
                specificationVersion: "v3" as const,
                async transformParams(args) {
                  if (args.type === "stream") {
                    // @ts-expect-error
                    args.params.prompt = ProviderTransform.message(
                      args.params.prompt,
                      input.model,
                      prepared.messageTransformOptions,
                    )
                  }
                  return args.params
                },
              },
            ],
          }),
          experimental_telemetry: {
            isEnabled: cfg.experimental?.openTelemetry,
            functionId: "session.llm",
            tracer: telemetryTracer,
            metadata: {
              userId: cfg.username ?? "unknown",
              sessionId: input.sessionID,
            },
          },
        }),
      }
    })

    const stream: Interface["stream"] = (input) =>
      Stream.scoped(
        Stream.unwrap(
          Effect.gen(function* () {
            const ctrl = yield* Effect.acquireRelease(
              Effect.sync(() => new AbortController()),
              (ctrl) => Effect.sync(() => ctrl.abort()),
            )

            const result = yield* run({ ...input, abort: ctrl.signal })

            if (result.type === "native") return result.stream

            // Adapter seam: both runtimes expose the same LLMEvent stream. Native
            // already returns one; AI SDK streams are converted here.
            const state = LLMAISDK.adapterState()
            return Stream.fromAsyncIterable(result.result.fullStream, (e) =>
              e instanceof Error ? e : new Error(String(e)),
            ).pipe(
              Stream.mapEffect((event) => LLMAISDK.toLLMEvents(state, event)),
              Stream.flatMap((events) => Stream.fromIterable(events)),
            )
          }),
        ),
      )

    return Service.of({ stream })
  }),
)

export const layer = live.pipe(Layer.provide(Permission.defaultLayer))

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Auth.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(
      LLMClient.layer.pipe(Layer.provide(Layer.mergeAll(RequestExecutor.defaultLayer, WebSocketExecutor.layer))),
    ),
    Layer.provide(RuntimeFlags.defaultLayer),
  ),
)

export const hasToolCalls = LLMRequestPrep.hasToolCalls

export * as LLM from "./llm"
