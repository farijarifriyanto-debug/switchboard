/**
 * Example Switchboard plugin — demonstrates that a plugin can add a tool, listen to
 * events and own its cleanup, all without touching harness internals.
 *
 * Enable it by adding "./plugins/echo-tool.mjs" to `plugins` in switchboard.config.jsonc.
 */
export const plugin = {
  name: 'echo-tool',
  inject: ['tools'],

  apply(ctx, config = {}) {
    const prefix = config.prefix ?? 'echo'

    ctx.effect(() =>
      ctx.tools.register({
        name: 'echo',
        description: 'Echo the given text back. Useful to verify the plugin pipeline.',
        parameters: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
        },
        execute: (args) => `${prefix}: ${args.text}`,
      }),
    )

    ctx.on('llm/metrics', (m) => {
      ctx.logger('echo-tool').debug('observed %c ms call to %c', m.totalMs, m.model)
    })
  },
}
