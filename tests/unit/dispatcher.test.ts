import { describe, expect, it, vi } from 'vitest';
import { createInteractionDispatcher } from '../../src/platform/commands/dispatcher.js';
import { ModuleRegistry, ModuleRegistryError } from '../../src/platform/plugin/registry.js';
import type {
  CommandDefinition,
  ComponentHandler,
  ModuleContext,
} from '../../src/platform/plugin/types.js';
import { silentLogger } from '../integration/helpers/db.js';

const ctx = { log: silentLogger, db: {}, client: {} } as unknown as ModuleContext;

const command = (name: string, execute = vi.fn()): CommandDefinition => ({
  name,
  data: { name, description: 'x' },
  execute,
});

/** The minimum an interaction needs to travel through the dispatcher. */
const chatInput = (name: string) => ({
  isAutocomplete: () => false,
  isMessageComponent: () => false,
  isChatInputCommand: () => true,
  commandName: name,
  guildId: '1',
  user: { id: '2' },
  deferred: false,
  replied: false,
  reply: vi.fn(),
  followUp: vi.fn(),
  editReply: vi.fn(),
  deferReply: vi.fn(),
});

const button = (customId: string) => ({
  isAutocomplete: () => false,
  isMessageComponent: () => true,
  isChatInputCommand: () => false,
  customId,
  guildId: '1',
  user: { id: '2' },
  deferred: false,
  replied: false,
  reply: vi.fn(),
  followUp: vi.fn(),
  editReply: vi.fn(),
});

const autocomplete = (name: string, respond = vi.fn()) => ({
  isAutocomplete: () => true,
  isMessageComponent: () => false,
  isChatInputCommand: () => false,
  commandName: name,
  respond,
});

describe('component routing', () => {
  it('routes a button to the handler owning its custom-id prefix', async () => {
    const handle = vi.fn();
    const components: ComponentHandler[] = [{ customIdPrefix: 'lb', handle }];
    const dispatch = createInteractionDispatcher({ commands: [], components, ctx });

    await dispatch(button('lb:page:xp:2:123') as never);

    expect(handle).toHaveBeenCalledOnce();
  });

  it('stays silent for a prefix nobody claims', async () => {
    // Almost always a component on a message from an older version of the bot.
    // An error reply on someone else's button is worse than nothing happening.
    const reply = vi.fn();
    const dispatch = createInteractionDispatcher({ commands: [], components: [], ctx });

    const interaction = button('someoneelse:thing');
    interaction.reply = reply;
    await dispatch(interaction as never);

    expect(reply).not.toHaveBeenCalled();
  });

  it('reports a failing component handler with a correlation id, not a stack trace', async () => {
    const reply = vi.fn();
    const components: ComponentHandler[] = [
      {
        customIdPrefix: 'lb',
        handle: () => {
          throw new Error('boom: connect ECONNREFUSED 10.0.0.1:5432');
        },
      },
    ];
    const dispatch = createInteractionDispatcher({ commands: [], components, ctx });

    const interaction = button('lb:page:xp:1:1');
    interaction.reply = reply;
    await dispatch(interaction as never);

    const content = (reply.mock.calls[0]?.[0] as { content: string }).content;
    expect(content).toMatch(/`[0-9a-f]{8}`/);
    expect(content).not.toContain('ECONNREFUSED');
  });
});

describe('autocomplete', () => {
  it('reaches the owning command', async () => {
    const respond = vi.fn();
    const auto = vi.fn(async (i: { respond: typeof respond }) => {
      await i.respond([]);
    });
    const dispatch = createInteractionDispatcher({
      commands: [{ ...command('level'), autocomplete: auto as never }],
      ctx,
    });

    await dispatch(autocomplete('level', respond) as never);
    expect(auto).toHaveBeenCalledOnce();
  });

  it('swallows a failure rather than trying to reply', async () => {
    // Discord permits neither a deferral nor an error message on autocomplete;
    // the only possible outcome is an empty list.
    const dispatch = createInteractionDispatcher({
      commands: [
        {
          ...command('level'),
          autocomplete: () => {
            throw new Error('registry exploded');
          },
        },
      ],
      ctx,
    });

    await expect(dispatch(autocomplete('level') as never)).resolves.toBeUndefined();
  });

  it('ignores autocomplete for a command that does not offer any', async () => {
    const dispatch = createInteractionDispatcher({ commands: [command('rank')], ctx });
    await expect(dispatch(autocomplete('rank') as never)).resolves.toBeUndefined();
  });
});

describe('chat input commands still work', () => {
  it('dispatches by name', async () => {
    const execute = vi.fn();
    const dispatch = createInteractionDispatcher({ commands: [command('rank', execute)], ctx });

    await dispatch(chatInput('rank') as never);
    expect(execute).toHaveBeenCalledOnce();
  });
});

describe('the module registry', () => {
  it('refuses two modules claiming the same component prefix', () => {
    // Same reasoning as duplicate command names: a coin flip about whose
    // handler runs, discovered in production.
    const registry = new ModuleRegistry();
    registry.register({
      name: 'a',
      requiredIntents: [],
      components: [{ customIdPrefix: 'lb', handle: vi.fn() }],
    });

    expect(() =>
      registry.register({
        name: 'b',
        requiredIntents: [],
        components: [{ customIdPrefix: 'lb', handle: vi.fn() }],
      }),
    ).toThrow(ModuleRegistryError);
  });

  it('collects component handlers across modules', () => {
    const registry = new ModuleRegistry();
    registry.register({
      name: 'a',
      requiredIntents: [],
      components: [{ customIdPrefix: 'lb', handle: vi.fn() }],
    });
    registry.register({
      name: 'b',
      requiredIntents: [],
      components: [{ customIdPrefix: 'poll', handle: vi.fn() }],
    });

    expect(registry.components().map((c) => c.customIdPrefix)).toEqual(['lb', 'poll']);
  });
});
