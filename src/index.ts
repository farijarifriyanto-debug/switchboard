import { Context } from 'cordis'
import type { SwitchboardConfig, PluginSpec } from './config.js'
import { mergeConfig, resolvePluginSrc } from './config.js'

// Side-effect imports: service interface augmentations + event typings.
import './events.js'
import './services/agent.js'
import { LLMService } from './services/llm.js'
import { ProviderRegistryService } from './services/providers.js'
import { PresetService } from './services/presets.js'
import { SkillService, toolsSkills } from './services/skills.js'
import { CompactionService } from './services/compaction.js'
import { toolsRecall } from './services/recall.js'
import { telegramChannel } from './channels/telegram.js'
import { AutomationService } from './services/automations.js'
import { UsageService } from './services/usage.js'
import { CredentialStoreService } from './services/credentials.js'
import { ToolsService } from './services/tools.js'
import { SessionService } from './services/session.js'
import { WorkspaceService } from './services/workspace.js'
import { ApprovalService } from './services/approval.js'
import { TraceService } from './services/trace.js'
import { MetricsService } from './plugins/metrics.js'
import { agentLoop } from './plugins/agent.js'
import { subagent } from './plugins/subagent.js'
import { toolsFs } from './plugins/tools-fs.js'
import { toolsShell } from './plugins/tools-shell.js'
import { toolsWeb } from './plugins/tools-web.js'
import { mcpBridge } from './plugins/mcp.js'
import { webUi, type WebUiConfig } from './plugins/web.js'

export interface Host {
  ctx: Context
  config: SwitchboardConfig
  /** Unloads every plugin and disposes the context. */
  dispose(): Promise<void>
}

async function loadExtraPlugin(ctx: Context, spec: PluginSpec): Promise<void> {
  const src = typeof spec === 'string' ? spec : spec.src
  const config = typeof spec === 'string' ? undefined : spec.config
  try {
    const mod: any = await import(resolvePluginSrc(src))
    const plugin = mod.plugin ?? mod.default
    if (!plugin) {
      ctx.logger('host').warn('plugin %c exports neither `plugin` nor `default`', src)
      return
    }
    await ctx.plugin(plugin, config)
    ctx.logger('host').info('loaded plugin %c', src)
  } catch (error) {
    ctx.logger('host').error('failed to load plugin %c: %s', src, String(error))
  }
}

/**
 * Boots a Switchboard host.
 *
 * The spine (llm, sessions, tools, agent-loop) is itself made of plugins —
 * replacing any of them is a matter of loading a different plugin before/after.
 */
export async function createHost(userConfig: SwitchboardConfig = {}): Promise<Host> {
  const config = mergeConfig(userConfig)
  const ctx = new Context()

  // Core services.
  await ctx.plugin(LLMService, config.llm ?? {})
  await ctx.plugin(ProviderRegistryService, { dir: config.settings?.dir, legacy: config.llm })
  await ctx.plugin(CredentialStoreService, { dir: config.settings?.dir, legacyConfigKey: config.llm?.apiKey })
  await ctx.plugin(SessionService, config.sessions ?? {})
  await ctx.plugin(PresetService, { dir: config.settings?.dir })
  await ctx.plugin(WorkspaceService, config.workspace ?? {})
  await ctx.plugin(ApprovalService, config.approval ?? {})
  await ctx.plugin(TraceService, config.trace ?? {})
  await ctx.plugin(MetricsService, config.metrics ?? {})
  await ctx.plugin(UsageService, config.usage ?? {})
  if (config.metrics?.load) await ctx.metrics.hydrate()
  if (config.sessions?.load !== false) await ctx.sessions.hydrate()

  // Tool registry + the shipped tool plugins.
  await ctx.plugin(CompactionService, config.compaction ?? {})
  await ctx.plugin(ToolsService)
  await ctx.plugin(toolsFs, config.tools?.fs ?? {})
  await ctx.plugin(toolsShell, config.tools?.shell ?? {})
  await ctx.plugin(toolsWeb, config.tools?.web ?? {})
  await ctx.plugin(SkillService, config.skills ?? {})
  await ctx.plugin(toolsSkills)
  await ctx.plugin(toolsRecall)
  await ctx.plugin(AutomationService, { dir: config.settings?.dir, ...(config.automations ?? {}) })

  // MCP servers, when configured (fail-open; validation throws on bad config).
  if (config.mcp !== undefined) await ctx.plugin(mcpBridge, config.mcp)

  // The agent loop spine.
  await ctx.plugin(agentLoop, config.agent ?? {})
  // Worker delegation (`task` tool) — needs the agent service first.
  await ctx.plugin(subagent, config.subagent ?? {})

  // The local operator console, when asked for.
  if (config.web?.enabled) {
    await ctx.plugin(
      webUi,
      {
        ...config.web,
        ci: config.ci,
        mcpConfigured: config.mcp !== undefined,
        // Non-secret agent settings for GET /api/settings (spec §6).
        agent: {
          ...(config.agent?.maxSteps !== undefined ? { maxSteps: config.agent.maxSteps } : {}),
          ...(config.agent?.temperature !== undefined ? { temperature: config.agent.temperature } : {}),
          ...(config.agent?.maxPromptTokens !== undefined ? { maxPromptTokens: config.agent.maxPromptTokens } : {}),
          ...(config.agent?.keepRecent !== undefined ? { keepRecent: config.agent.keepRecent } : {}),
          systemSource: config.agent?.system ? 'custom' : 'default',
        },
      } as WebUiConfig,
    )
  }

  // Chat channels (explicit opt-in; they fail closed when misconfigured).
  if (config.channels?.telegram?.enabled) await ctx.plugin(telegramChannel, { dir: config.settings?.dir, ...config.channels.telegram })

  // User-provided plugins.
  for (const spec of config.plugins ?? []) await loadExtraPlugin(ctx, spec)

  return {
    ctx,
    config,
    async dispose() {
      for (const runtime of [...ctx.registry.values()]) {
        for (const fiber of [...runtime.fibers]) {
          await fiber.dispose()
        }
      }
    },
  }
}

export { Context } from 'cordis'
export { LLMService } from './services/llm.js'
export { ToolsService } from './services/tools.js'
export { SessionService } from './services/session.js'
export { PresetService } from './services/presets.js'
export { SkillService } from './services/skills.js'
export { CompactionService } from './services/compaction.js'
export { telegramChannel } from './channels/telegram.js'
export { AutomationService } from './services/automations.js'
export { UsageService, formatUsage, costOf, priceFromModel } from './services/usage.js'
export { WorkspaceService } from './services/workspace.js'
export { ApprovalService } from './services/approval.js'
export { TraceService } from './services/trace.js'
export { MetricsService } from './plugins/metrics.js'
export { agentLoop } from './plugins/agent.js'
export { subagent } from './plugins/subagent.js'
export { toolsFs, toolsShell, toolsWeb }
export { mcpBridge }
export { webUi }
export type { WebUiConfig } from './plugins/web.js'
export * from './config.js'
export * from './types.js'
