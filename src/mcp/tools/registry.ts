// Tool registry — maps tool names → handlers, annotations, schemas.
// Handles filtering (--read-only, --no-destructive, --toolsets).

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { withAudit } from '../audit.js'
import {
  TOOLSETS,
  type Toolset,
  clawops_statusSchema,          clawops_statusAnnotations,
  clawops_logs_tailSchema,       clawops_logs_tailAnnotations,
  clawops_stacks_listSchema,     clawops_stacks_listAnnotations,
  clawops_config_getSchema,      clawops_config_getAnnotations,
  clawops_agents_listSchema,     clawops_agents_listAnnotations,
  clawops_upSchema,              clawops_upAnnotations,
  clawops_destroySchema,         clawops_destroyAnnotations,
  clawops_applySchema,           clawops_applyAnnotations,
  clawops_planSchema,            clawops_planAnnotations,
  clawops_config_setSchema,      clawops_config_setAnnotations,
  clawops_agents_restartSchema,  clawops_agents_restartAnnotations,
  clawops_gateway_restartSchema, clawops_gateway_restartAnnotations,
  clawops_workflow_deploy_appSchema, clawops_workflow_deploy_appAnnotations,
  clawops_workflow_recoverSchema,    clawops_workflow_recoverAnnotations,
  clawops_task_statusSchema,     clawops_task_statusAnnotations,
  type StatusInput, type LogsTailInput, type StacksListInput,
  type ConfigGetInput, type AgentsListInput, type UpInput,
  type DestroyInput, type ApplyInput, type PlanInput,
  type ConfigSetInput, type AgentsRestartInput, type GatewayRestartInput,
  type WorkflowDeployAppInput, type WorkflowRecoverInput, type TaskStatusInput,
} from './_generated.js'

import type { McpServeOpts } from '../server.js'

// ── Handler imports ──────────────────────────────────────────────────────────
import { handleStatus } from './cli/status.js'
import { handleLogsTail } from './cli/logs.js'
import { handleStacksList } from './cli/stacks.js'
import { handleConfigGet, handleConfigSet } from './cli/config.js'
import { handleAgentsList, handleAgentsRestart } from './cli/agents.js'
import { handleGatewayRestart } from './cli/gateway.js'
import { handleUp } from './cli/up.js'
import { handleDestroy } from './cli/destroy.js'
import { handlePlan } from './cli/plan.js'
import { handleApply } from './cli/apply.js'
import { handleTaskStatus } from './cli/task.js'
import { handleWorkflowDeployApp } from './workflow/deploy_app.js'
import { handleWorkflowRecover } from './workflow/recover.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHandler = (input: any, server: McpServer) => Promise<CallToolResult>
interface ToolEntry {
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
): ToolEntry {
  return { schema, annotations, handler: handler as AnyHandler }
}

const TOOL_REGISTRY: Record<string, ToolEntry> = {
  clawops_status:           makeEntry<StatusInput>(clawops_statusSchema, clawops_statusAnnotations, handleStatus),
  clawops_logs_tail:        makeEntry<LogsTailInput>(clawops_logs_tailSchema, clawops_logs_tailAnnotations, handleLogsTail),
  clawops_stacks_list:      makeEntry<StacksListInput>(clawops_stacks_listSchema, clawops_stacks_listAnnotations, handleStacksList),
  clawops_config_get:       makeEntry<ConfigGetInput>(clawops_config_getSchema, clawops_config_getAnnotations, handleConfigGet),
  clawops_agents_list:      makeEntry<AgentsListInput>(clawops_agents_listSchema, clawops_agents_listAnnotations, handleAgentsList),
  clawops_up:               makeEntry<UpInput>(clawops_upSchema, clawops_upAnnotations, handleUp),
  clawops_destroy:          makeEntry<DestroyInput>(clawops_destroySchema, clawops_destroyAnnotations, handleDestroy),
  clawops_apply:            makeEntry<ApplyInput>(clawops_applySchema, clawops_applyAnnotations, handleApply),
  clawops_plan:             makeEntry<PlanInput>(clawops_planSchema, clawops_planAnnotations, handlePlan),
  clawops_config_set:       makeEntry<ConfigSetInput>(clawops_config_setSchema, clawops_config_setAnnotations, handleConfigSet),
  clawops_agents_restart:   makeEntry<AgentsRestartInput>(clawops_agents_restartSchema, clawops_agents_restartAnnotations, handleAgentsRestart),
  clawops_gateway_restart:  makeEntry<GatewayRestartInput>(clawops_gateway_restartSchema, clawops_gateway_restartAnnotations, handleGatewayRestart),
  clawops_workflow_deploy_app: makeEntry<WorkflowDeployAppInput>(clawops_workflow_deploy_appSchema, clawops_workflow_deploy_appAnnotations, handleWorkflowDeployApp),
  clawops_workflow_recover: makeEntry<WorkflowRecoverInput>(clawops_workflow_recoverSchema, clawops_workflow_recoverAnnotations, handleWorkflowRecover),
  clawops_task_status:      makeEntry<TaskStatusInput>(clawops_task_statusSchema, clawops_task_statusAnnotations, handleTaskStatus),
}

/** Resolve which tool names should be registered given the serve opts. */
export function resolveEnabledTools(opts: McpServeOpts): string[] {
  let names: string[]

  if (opts.readOnly) {
    names = [...TOOLSETS.read]
  } else if (opts.toolsets && opts.toolsets.length > 0) {
    names = opts.toolsets.flatMap((ts) => TOOLSETS[ts as Toolset] ?? [])
  } else {
    // Default: cli + workflow + admin (all 15 tools)
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
    const { schema, annotations, handler } = entry
    const { title, readOnlyHint, destructiveHint, idempotentHint, openWorldHint } = annotations
    const audited = withAudit(toolName, (input) => handler(input, server))
    server.registerTool(
      toolName,
      {
        title,
        inputSchema: schema,
        annotations: { title, readOnlyHint, destructiveHint, idempotentHint, openWorldHint },
      },
      audited,
    )
  }
}
