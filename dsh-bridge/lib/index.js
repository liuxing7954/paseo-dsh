/**
 * The Paseo bridge profile app: command-line and stdin-lifetime provider for
 * the stdio JSON-RPC surface that Paseo drives.
 *
 * Mirrors the shipped `dsh-sdk-app` bundle so `--help` starts no transport and
 * stdin EOF binds to a bounded shutdown.
 *
 * @module dsh-paseo-bridge
 */
import { Command } from 'commander';
import Schema from '@deepseek-ai/schemastery';
import { exitOnStdinEnd, parseCmdline } from '@deepseek-ai/dsh-cmdline';
import { PaseoTransport } from './transport.js';
import { PaseoHarnessServer } from './server.js';

/** Stable Cordis plugin name. */
export const name = 'paseo-bridge';
/** Command-line and agent-factory services this app composes over. */
export const inject = ['cmdlineArgs', 'agents'];
export const Config = Schema.object({
  profile: Schema.string().default('paseo'),
  /**
   * Provider id -> adapter module the bridge loads on demand when the profile
   * composes no adapter for that provider.
   *
   * The default covers a bare `dsh-base` bundle, which ships without the hosted
   * DeepSeek adapter. Override or extend it when your route needs an adapter
   * your bundle does not include; a provider absent from this map fails with an
   * explanation rather than being guessed at.
   */
  adapters: Schema.dict(Schema.string()).default({
    'deepseek-official': '@deepseek-ai/dsh-llm-deepseek-api-key',
  }),
});

function paseoCommand(profile) {
  return new Command()
    .name(`dsh --profile ${profile}`)
    .description('Serve the Paseo bridge over stdio JSON-RPC.')
    .helpOption('-h, --help', 'show this help')
    .addHelpText(
      'after',
      `
Example:
  dsh --profile ${profile}     serve one Paseo bridge runtime until its client disconnects
`,
    );
}

/** Accept a Paseo bridge invocation, bind EOF, and claim stdio. */
export function apply(ctx, config = {}) {
  const program = paseoCommand(config.profile ?? 'paseo');
  program.action(() => {
    exitOnStdinEnd(ctx, 'paseo-bridge.stdin');
    startBridge(ctx, config);
  });
  parseCmdline(ctx, program);
}

function normalizeAnswer(result) {
  if (result !== null && typeof result === 'object' && Array.isArray(result.answers)) {
    return { answers: result.answers };
  }
  throw new Error('paseo bridge: the client returned a malformed question answer');
}

function startBridge(ctx, config = {}) {
  const transport = new PaseoTransport(process.stdin, process.stdout);
  const server = new PaseoHarnessServer(ctx, transport, { adapters: config.adapters ?? {} });
  const rootFiber = ctx.root.fiber;
  let exitTask;

  const disposeAndExit = (code) => {
    exitTask ??= (async () => {
      await Promise.allSettled([transport.flush()]);
      await Promise.allSettled([Promise.resolve().then(() => rootFiber.dispose())]);
      process.exit(code);
    })();
    return exitTask;
  };

  transport.onRequest(async (method, params) => {
    if (method === 'initialize') await ctx.get('loader')?.await();
    const result = await server.handleRequest(method, params);
    if (method === 'shutdown') {
      setImmediate(() => {
        void disposeAndExit(0);
      });
    }
    return result;
  });

  ctx.effect(() => {
    transport.start();

    // DSH -> Paseo. Root-context registration matches how the shipped ACP
    // adapter claims `approval/request`; each listener answers only for the
    // sessions this server owns and otherwise delegates down the waterfall.
    const offQuestions = ctx.on('user-questions/request', (request, next) => {
      const agent = request.agent;
      if (agent === undefined) return next();
      const sessionId = String(agent.session.id);
      if (!server.owns(sessionId)) return next();
      return transport
        .request(
          'paseo/question',
          {
            sessionId,
            callId: request.wait?.callId === undefined ? null : String(request.wait.callId),
            timed: request.wait?.timed === true,
            questions: request.questions,
          },
          request.signal,
        )
        .then(normalizeAnswer);
    });

    return async () => {
      offQuestions();
      await server.shutdown();
      transport.close();
    };
  }, 'paseo-bridge.serve');
}
