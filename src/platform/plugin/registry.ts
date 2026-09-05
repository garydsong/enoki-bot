import type { GatewayIntentBits } from 'discord.js';
import type {
  BotModule,
  CommandDefinition,
  ComponentHandler,
  JobDefinition,
} from './types.js';

/**
 * Composes the enabled modules into the things the core needs: one intent set,
 * one command list, one job list.
 *
 * Duplicate detection is strict and fails at boot rather than at runtime — two
 * modules claiming `/rank` would otherwise produce a coin-flip about which
 * handler runs, discovered in production.
 */
export class ModuleRegistryError extends Error {}

export class ModuleRegistry {
  private readonly modules: BotModule[] = [];

  register(module: BotModule): this {
    if (this.modules.some((m) => m.name === module.name)) {
      throw new ModuleRegistryError(`duplicate module name: ${module.name}`);
    }

    for (const command of module.commands ?? []) {
      const owner = this.findCommandOwner(command.name);
      if (owner) {
        throw new ModuleRegistryError(
          `command /${command.name} is claimed by both "${owner}" and "${module.name}"`,
        );
      }
    }

    // Same reasoning as commands: two modules answering the same custom-id
    // prefix is a coin flip about whose button handler runs.
    for (const component of module.components ?? []) {
      const owner = this.findComponentOwner(component.customIdPrefix);
      if (owner) {
        throw new ModuleRegistryError(
          `component prefix "${component.customIdPrefix}" is claimed by both ` +
            `"${owner}" and "${module.name}"`,
        );
      }
    }

    this.modules.push(module);
    return this;
  }

  private findCommandOwner(name: string): string | null {
    for (const m of this.modules) {
      if ((m.commands ?? []).some((c) => c.name === name)) return m.name;
    }
    return null;
  }

  all(): readonly BotModule[] {
    return this.modules;
  }

  /**
   * The union of every enabled module's required intents. Least privilege by
   * construction: disabling a module narrows what the gateway asks for, and no
   * intent is ever requested because "we might need it".
   */
  intents(): GatewayIntentBits[] {
    const set = new Set<GatewayIntentBits>();
    for (const m of this.modules) for (const i of m.requiredIntents) set.add(i);
    return [...set].sort((a, b) => a - b);
  }

  private findComponentOwner(prefix: string): string | null {
    for (const m of this.modules) {
      if ((m.components ?? []).some((c) => c.customIdPrefix === prefix)) return m.name;
    }
    return null;
  }

  commands(): CommandDefinition[] {
    return this.modules.flatMap((m) => [...(m.commands ?? [])]);
  }

  components(): ComponentHandler[] {
    return this.modules.flatMap((m) => [...(m.components ?? [])]);
  }

  jobs(): { module: BotModule; job: JobDefinition }[] {
    return this.modules.flatMap((m) => (m.jobs ?? []).map((job) => ({ module: m, job })));
  }

  migrationDirs(): string[] {
    return this.modules
      .map((m) => m.migrationsDir)
      .filter((d): d is string => typeof d === 'string');
  }

  /**
   * Migration sources namespaced by MODULE NAME. Module names are already
   * unique (enforced in `register`), so this is what makes "two modules can
   * each own a 0001_" actually true — every module's folder is called
   * `migrations`, so the path cannot distinguish them.
   */
  migrationSources(): { namespace: string; dir: string }[] {
    return this.modules
      .filter((m) => typeof m.migrationsDir === 'string')
      .map((m) => ({ namespace: m.name, dir: m.migrationsDir as string }));
  }
}
