// Tool registry — maps tool names → handlers, annotations, schemas.
// Handles filtering (--read-only, --no-destructive, --toolsets).

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { withAudit } from '../audit.js'
import {
  TOOLSETS,
  type Toolset,
  clawops_statusSchema,          clawops_statusAnnotations, clawops_statusDescription,
  clawops_doctorSchema,          clawops_doctorAnnotations, clawops_doctorDescription,
  clawops_logs_tailSchema,       clawops_logs_tailAnnotations, clawops_logs_tailDescription,
  clawops_monitorSchema,         clawops_monitorAnnotations, clawops_monitorDescription,
  clawops_stacks_listSchema,     clawops_stacks_listAnnotations, clawops_stacks_listDescription,
  clawops_config_getSchema,      clawops_config_getAnnotations, clawops_config_getDescription,
  clawops_agents_listSchema,     clawops_agents_listAnnotations, clawops_agents_listDescription,
  clawops_upSchema,              clawops_upAnnotations, clawops_upDescription,
  clawops_destroySchema,         clawops_destroyAnnotations, clawops_destroyDescription,
  clawops_applySchema,           clawops_applyAnnotations, clawops_applyDescription,
  clawops_planSchema,            clawops_planAnnotations, clawops_planDescription,
  clawops_hardenSchema,          clawops_hardenAnnotations, clawops_hardenDescription,
  clawops_config_setSchema,      clawops_config_setAnnotations, clawops_config_setDescription,
  clawops_config_unsetSchema,    clawops_config_unsetAnnotations, clawops_config_unsetDescription,
  clawops_config_validateSchema, clawops_config_validateAnnotations, clawops_config_validateDescription,
  clawops_gateway_restartSchema, clawops_gateway_restartAnnotations, clawops_gateway_restartDescription,
  clawops_workflow_deploy_appSchema, clawops_workflow_deploy_appAnnotations, clawops_workflow_deploy_appDescription,
  clawops_workflow_recoverSchema,    clawops_workflow_recoverAnnotations, clawops_workflow_recoverDescription,
  clawops_task_statusSchema,     clawops_task_statusAnnotations, clawops_task_statusDescription,
  type StatusInput, type LogsTailInput, type StacksListInput,
  type DoctorInput, type ConfigGetInput, type AgentsListInput, type UpInput,
  type DestroyInput, type ApplyInput, type PlanInput, type HardenInput,
  type ConfigSetInput, type ConfigUnsetInput, type ConfigValidateInput,
  type GatewayRestartInput,
  type WorkflowDeployAppInput, type WorkflowRecoverInput, type TaskStatusInput,
  type MonitorInput,
} from './_generated.js'

import type { McpServeOpts } from '../server.js'

// ── Handler imports ──────────────────────────────────────────────────────────
import { handleStatus } from './cli/status.js'
import { handleDoctor } from './cli/doctor.js'
import { handleLogsTail } from './cli/logs.js'
import { handleStacksList } from './cli/stacks.js'
import { handleConfigGet, handleConfigSet, handleConfigUnset, handleConfigValidate } from './cli/config.js'
import { handleAgentsList } from './cli/agents.js'
import { handleGatewayRestart } from './cli/gateway.js'
import { handleUp } from './cli/up.js'
import { handleDestroy } from './cli/destroy.js'
import { handlePlan } from './cli/plan.js'
import { handleHarden } from './cli/harden.js'
import { handleApply } from './cli/apply.js'
import { handleTaskStatus } from './cli/task.js'
import { handleMonitor } from './cli/monitor.js'
import { handleWorkflowDeployApp } from './workflow/deploy_app.js'
import { handleWorkflowRecover } from './workflow/recover.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHandler = (input: any, server: McpServer) => Promise<CallToolResult>
interface ToolEntry {
  /** What a model reads when choosing a tool. Generated from spec/mcp-tools.yaml. */
  description: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema: any
  annotations: {
    title: string
    readOnlyHint: boolean
    destructiveHint: boolean
    idempotentHint: boolean
    openWorldHint: boolean
  }
  handler: AnyHandler
}

function makeEntry<T>(
  schema: unknown,
  annotations: { title: string; readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean },
  handler: (input: T, server: McpServer) => Promise<CallToolResult>,
  description: string,
): ToolEntry {
  return { schema, annotations, handler: handler as AnyHandler, description }
}

const TOOL_REGISTRY: Record<string, ToolEntry> = {
  clawops_status:           makeEntry<StatusInput>(clawops_statusSchema, clawops_statusAnnotations, handleStatus, clawops_statusDescription),
  clawops_doctor:           makeEntry<DoctorInput>(clawops_doctorSchema, clawops_doctorAnnotations, handleDoctor, clawops_doctorDescription),
  clawops_logs_tail:        makeEntry<LogsTailInput>(clawops_logs_tailSchema, clawops_logs_tailAnnotations, handleLogsTail, clawops_logs_tailDescription),
  clawops_monitor:          makeEntry<MonitorInput>(clawops_monitorSchema, clawops_monitorAnnotations, handleMonitor, clawops_monitorDescription),
  clawops_stacks_list:      makeEntry<StacksListInput>(clawops_stacks_listSchema, clawops_stacks_listAnnotations, handleStacksList, clawops_stacks_listDescription),
  clawops_config_get:       makeEntry<ConfigGetInput>(clawops_config_getSchema, clawops_config_getAnnotations, handleConfigGet, clawops_config_getDescription),
  clawops_agents_list:      makeEntry<AgentsListInput>(clawops_agents_listSchema, clawops_agents_listAnnotations, handleAgentsList, clawops_agents_listDescription),
  clawops_up:               makeEntry<UpInput>(clawops_upSchema, clawops_upAnnotations, handleUp, clawops_upDescription),
  clawops_destroy:          makeEntry<DestroyInput>(clawops_destroySchema, clawops_destroyAnnotations, handleDestroy, clawops_destroyDescription),
  clawops_apply:            makeEntry<ApplyInput>(clawops_applySchema, clawops_applyAnnotations, handleApply, clawops_applyDescription),
  clawops_plan:             makeEntry<PlanInput>(clawops_planSchema, clawops_planAnnotations, handlePlan, clawops_planDescription),
  clawops_harden:           makeEntry<HardenInput>(clawops_hardenSchema, clawops_hardenAnnotations, handleHarden, clawops_hardenDescription),
  clawops_config_set:       makeEntry<ConfigSetInput>(clawops_config_setSchema, clawops_config_setAnnotations, handleConfigSet, clawops_config_setDescription),
  clawops_config_unset:     makeEntry<ConfigUnsetInput>(clawops_config_unsetSchema, clawops_config_unsetAnnotations, handleConfigUnset, clawops_config_unsetDescription),
  clawops_config_validate:  makeEntry<ConfigValidateInput>(clawops_config_validateSchema, clawops_config_validateAnnotations, handleConfigValidate, clawops_config_validateDescription),
  clawops_gateway_restart:  makeEntry<GatewayRestartInput>(clawops_gateway_restartSchema, clawops_gateway_restartAnnotations, handleGatewayRestart, clawops_gateway_restartDescription),
  clawops_workflow_deploy_app: makeEntry<WorkflowDeployAppInput>(clawops_workflow_deploy_appSchema, clawops_workflow_deploy_appAnnotations, handleWorkflowDeployApp, clawops_workflow_deploy_appDescription),
  clawops_workflow_recover: makeEntry<WorkflowRecoverInput>(clawops_workflow_recoverSchema, clawops_workflow_recoverAnnotations, handleWorkflowRecover, clawops_workflow_recoverDescription),
  clawops_task_status:      makeEntry<TaskStatusInput>(clawops_task_statusSchema, clawops_task_statusAnnotations, handleTaskStatus, clawops_task_statusDescription),
}

/** The registry itself, for tests that assert what a client is handed. */
export const TOOL_REGISTRY_FOR_TESTS: Readonly<Record<string, ToolEntry>> = TOOL_REGISTRY

/** Every tool this server can serve. Asserted against spec/mcp-tools.yaml in tests. */
export const TOOL_NAMES: readonly string[] = Object.keys(TOOL_REGISTRY)

/** Resolve which tool names should be registered given the serve opts. */
export function resolveEnabledTools(opts: McpServeOpts): string[] {
  let names: string[]

  if (opts.readOnly) {
    names = [...TOOLSETS.read]
  } else if (opts.toolsets && opts.toolsets.length > 0) {
    names = opts.toolsets.flatMap((ts) => TOOLSETS[ts as Toolset] ?? [])
  } else {
    // Default: cli + workflow + admin (all cli + workflow + admin tools)
    names = [
      ...TOOLSETS.cli,
      ...TOOLSETS.workflow,
      ...TOOLSETS.admin,
    ]
  }

  if (opts.noDestructive) {
    names = names.filter((n) => {
      const entry = TOOL_REGISTRY[n]
      return entry ? !entry.annotations.destructiveHint : true
    })
  }

  // Deduplicate (some names appear in multiple toolsets)
  return [...new Set(names)]
}

/** Register all enabled tools on the MCP server. */
export function registerTools(server: McpServer, opts: McpServeOpts): void {
  const enabled = resolveEnabledTools(opts)
  for (const toolName of enabled) {
    const entry = TOOL_REGISTRY[toolName]
    if (!entry) continue
    const { schema, annotations, handler, description } = entry
    const { title, readOnlyHint, destructiveHint, idempotentHint, openWorldHint } = annotations
    const audited = withAudit(toolName, (input) => handler(input, server))
    server.registerTool(
      toolName,
      {
        title,
        // What a model reads when it picks a tool. Written per R3 to say when to use this one
        // and when to reach for another; omitted here, every client saw a nameless capability.
        description,
        inputSchema: schema,
        annotations: { title, readOnlyHint, destructiveHint, idempotentHint, openWorldHint },
      },
      audited,
    )
  }
}
