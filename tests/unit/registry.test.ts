import { describe, expect, it } from 'vitest';
import { GatewayIntentBits } from 'discord.js';
import { ModuleRegistry, ModuleRegistryError } from '../../src/platform/plugin/registry.js';
import {
  describeIntents,
  explainDisallowedIntents,
  hasMessageContent,
  isDisallowedIntentsError,
  isPrivileged,
  privilegedAmong,
} from '../../src/platform/discord/intents.js';
import { commandSetHash } from '../../src/platform/commands/registrar.js';
import { createLevelingModule } from '../../src/modules/leveling/index.js';
import type { BotModule } from '../../src/platform/plugin/types.js';

const mod = (over: Partial<BotModule> = {}): BotModule => ({
  name: 'test',
  requiredIntents: [GatewayIntentBits.Guilds],
  ...over,
});

const cmd = (name: string) => ({
  name,
  data: { name, description: 'x' } as never,
  execute: async () => {},
});

describe('module registry', () => {
  it('composes the union of required intents', () => {
    const registry = new ModuleRegistry()
      .register(mod({ name: 'a', requiredIntents: [GatewayIntentBits.Guilds] }))
      .register(
        mod({
          name: 'b',
          requiredIntents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
        }),
      );

    const intents = registry.intents();
    expect(intents).toContain(GatewayIntentBits.Guilds);
    expect(intents).toContain(GatewayIntentBits.GuildMessages);
    expect(intents).toHaveLength(2); // deduplicated
  });

  it('narrows intents when a module is not registered', () => {
    const withVoice = new ModuleRegistry().register(
      mod({ requiredIntents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] }),
    );
    const without = new ModuleRegistry().register(
      mod({ requiredIntents: [GatewayIntentBits.Guilds] }),
    );
    expect(withVoice.intents()).toContain(GatewayIntentBits.GuildVoiceStates);
    expect(without.intents()).not.toContain(GatewayIntentBits.GuildVoiceStates);
  });

  it('refuses two modules with the same name', () => {
    const registry = new ModuleRegistry().register(mod({ name: 'dup' }));
    expect(() => registry.register(mod({ name: 'dup' }))).toThrow(ModuleRegistryError);
  });

  /**
   * Two modules claiming /rank would otherwise be a coin-flip about which
   * handler runs, discovered in production. Fail at boot instead.
   */
  it('refuses two modules claiming the same command, naming both', () => {
    const registry = new ModuleRegistry().register(
      mod({ name: 'alpha', commands: [cmd('rank')] }),
    );
    expect(() => registry.register(mod({ name: 'beta', commands: [cmd('rank')] }))).toThrow(
      /claimed by both "alpha" and "beta"/,
    );
  });

  it('collects commands, jobs and migration dirs across modules', () => {
    const registry = new ModuleRegistry()
      .register(
        mod({
          name: 'a',
          commands: [cmd('one')],
          jobs: [{ name: 'ja', intervalMs: 1000, run: async () => {} }],
          migrationsDir: '/tmp/a',
        }),
      )
      .register(mod({ name: 'b', commands: [cmd('two')], migrationsDir: '/tmp/b' }));

    expect(registry.commands().map((c) => c.name)).toEqual(['one', 'two']);
    expect(registry.jobs()).toHaveLength(1);
    expect(registry.migrationDirs()).toEqual(['/tmp/a', '/tmp/b']);
  });

  it('omits modules that own no tables from the migration dirs', () => {
    const registry = new ModuleRegistry().register(mod({ name: 'a' }));
    expect(registry.migrationDirs()).toEqual([]);
  });
});

describe('intents', () => {
  it('knows the three privileged intents and nothing else', () => {
    expect(isPrivileged(GatewayIntentBits.GuildMembers)).toBe(true);
    expect(isPrivileged(GatewayIntentBits.MessageContent)).toBe(true);
    expect(isPrivileged(GatewayIntentBits.GuildPresences)).toBe(true);
    expect(isPrivileged(GatewayIntentBits.Guilds)).toBe(false);
    expect(isPrivileged(GatewayIntentBits.GuildMessages)).toBe(false);
  });

  it('names privileged intents so a boot failure is diagnosable', () => {
    const names = privilegedAmong([
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.MessageContent,
    ]);
    expect(names).toEqual(['GuildMembers', 'MessageContent']);
  });

  it('labels privileged intents in the human-readable description', () => {
    const described = describeIntents([GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]);
    expect(described).toContain('Guilds');
    expect(described).toContain('GuildMembers (privileged)');
  });

  it('reports whether the MessageContent capability is present', () => {
    expect(hasMessageContent([GatewayIntentBits.Guilds])).toBe(false);
    expect(hasMessageContent([GatewayIntentBits.MessageContent])).toBe(true);
  });
});

describe('the leveling module', () => {
  it('never requests GuildPresences', () => {
    const m = createLevelingModule({ requestMessageContent: true });
    expect(m.requiredIntents).not.toContain(GatewayIntentBits.GuildPresences);
  });

  it('always requests the intents leveling cannot work without', () => {
    const m = createLevelingModule({ requestMessageContent: false });
    expect(m.requiredIntents).toContain(GatewayIntentBits.Guilds);
    expect(m.requiredIntents).toContain(GatewayIntentBits.GuildMessages);
    expect(m.requiredIntents).toContain(GatewayIntentBits.GuildMembers);
  });

  /** Spec `03` §1.1: the bot must run without it, disabling only its features. */
  it('treats MessageContent as optional', () => {
    const on = createLevelingModule({ requestMessageContent: true });
    const off = createLevelingModule({ requestMessageContent: false });
    expect(on.requiredIntents).toContain(GatewayIntentBits.MessageContent);
    expect(off.requiredIntents).not.toContain(GatewayIntentBits.MessageContent);
  });

  it('registers cleanly and owns a migrations directory', () => {
    const m = createLevelingModule({ requestMessageContent: true });
    expect(() => new ModuleRegistry().register(m)).not.toThrow();
    expect(m.migrationsDir).toMatch(/modules[/\\]leveling[/\\]migrations$/);
  });
});

describe('command set hashing', () => {
  const a = { name: 'rank', description: 'r' } as never;
  const b = { name: 'xp', description: 'x' } as never;

  it('is stable across reordering, so a code shuffle is not an upload', () => {
    expect(commandSetHash([a, b])).toBe(commandSetHash([b, a]));
  });

  it('changes when a command changes', () => {
    const changed = { name: 'rank', description: 'different' } as never;
    expect(commandSetHash([a, b])).not.toBe(commandSetHash([changed, b]));
  });

  it('changes when a command is added or removed', () => {
    expect(commandSetHash([a])).not.toBe(commandSetHash([a, b]));
  });

  it('handles an empty command set', () => {
    expect(commandSetHash([])).toHaveLength(32);
  });
});

/**
 * "Used disallowed intents" is the single most common first-run failure for a
 * Discord bot, and Discord's message names neither the intent, nor the
 * application, nor where to fix it — and arrives as a WebSocket close, so the
 * stack points into the library.
 */
describe('disallowed-intents diagnosis', () => {
  it('recognises the error whatever wrapping it arrives in', () => {
    expect(isDisallowedIntentsError(new Error('Used disallowed intents'))).toBe(true);
    expect(isDisallowedIntentsError(new Error('used DISALLOWED INTENTS'))).toBe(true);
    expect(isDisallowedIntentsError('Used disallowed intents')).toBe(true);
  });

  it('does not swallow unrelated errors', () => {
    expect(isDisallowedIntentsError(new Error('ECONNRESET'))).toBe(false);
    expect(isDisallowedIntentsError(new Error('Invalid token'))).toBe(false);
  });

  it('names the exact toggles, in the words the Developer Portal uses', () => {
    const message = explainDisallowedIntents(
      [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.MessageContent],
      '1545460676426993754',
    );
    expect(message).toContain('Server Members Intent');
    expect(message).toContain('Message Content Intent');
    // Non-privileged intents are not the problem and must not be listed.
    expect(message).not.toContain('Guilds  (Guilds)');
  });

  it('links straight to the settings page for THIS application', () => {
    const message = explainDisallowedIntents([GatewayIntentBits.GuildMembers], '999888777666555444');
    expect(message).toContain('https://discord.com/developers/applications/999888777666555444/bot');
  });

  it('offers the escape hatch, and is honest about which intent has none', () => {
    const message = explainDisallowedIntents(
      [GatewayIntentBits.GuildMembers, GatewayIntentBits.MessageContent],
      '1',
    );
    expect(message).toContain('ENABLE_MESSAGE_CONTENT=false');
    expect(message).toContain('Server Members cannot be skipped');
  });
});

describe('migration namespacing', () => {
  it('namespaces by module name, not by folder name', () => {
    // Every module's migrations folder is called `migrations`, so a path-derived
    // namespace gives them all the same one — and the second module to ship a
    // 0001_ would find its migration already recorded and silently skipped.
    const registry = new ModuleRegistry();
    registry.register({
      name: 'leveling',
      requiredIntents: [],
      migrationsDir: '/app/src/modules/leveling/migrations',
    });
    registry.register({
      name: 'moderation',
      requiredIntents: [],
      migrationsDir: '/app/src/modules/moderation/migrations',
    });

    expect(registry.migrationSources()).toEqual([
      { namespace: 'leveling', dir: '/app/src/modules/leveling/migrations' },
      { namespace: 'moderation', dir: '/app/src/modules/moderation/migrations' },
    ]);
  });

  it('omits modules that own no tables', () => {
    const registry = new ModuleRegistry();
    registry.register({ name: 'stateless', requiredIntents: [] });
    expect(registry.migrationSources()).toEqual([]);
  });
});
