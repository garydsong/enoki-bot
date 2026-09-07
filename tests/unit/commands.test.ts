import { describe, expect, it } from 'vitest';
import { createLevelingModule } from '../../src/modules/leveling/index.js';
import { customIdsFor } from '../../src/modules/leveling/adapters/commands/leaderboard.js';
import type { LeaderboardPage } from '../../src/modules/leveling/application/queries/leaderboard.js';

/**
 * Discord validates command definitions at REGISTRATION time, over REST, during
 * boot. A description one character too long, a name with a capital letter, or a
 * 26th choice does not fail a type check or a lint — it fails the bot's startup,
 * in front of the person running it, with an error that points at a JSON path.
 *
 * These assertions are Discord's published limits, checked here so the failure
 * happens in the test suite instead.
 */

const module_ = createLevelingModule({ requestMessageContent: true });
const commands = module_.commands ?? [];

interface OptionLike {
  name: string;
  description: string;
  /** 1 = subcommand, 2 = subcommand group; neither carries `required`. */
  type?: number;
  required?: boolean;
  options?: OptionLike[];
  choices?: { name: string; value: string | number }[];
  autocomplete?: boolean;
}

function walk(options: OptionLike[] | undefined, visit: (o: OptionLike) => void): void {
  for (const option of options ?? []) {
    visit(option);
    walk(option.options, visit);
  }
}

describe('the leveling module’s command surface', () => {
  it('registers the commands a usable bot needs', () => {
    expect(commands.map((c) => c.name).sort()).toEqual([
      'card',
      'leaderboard',
      'level',
      'rank',
      'xp',
    ]);
  });

  it('matches each definition’s name to the name inside its JSON', () => {
    // A mismatch means the dispatcher can never find the handler: Discord
    // dispatches on the JSON name, the registry keys on the other one.
    for (const command of commands) {
      expect(command.data.name, command.name).toBe(command.name);
    }
  });

  it('keeps every name and description inside Discord’s limits', () => {
    for (const command of commands) {
      const data = command.data as { name: string; description?: string };
      expect(data.name).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
      // Chat-input commands always carry one; a context-menu command would not.
      expect(data.description?.length ?? 0, command.name).toBeLessThanOrEqual(100);
      expect(data.description?.length ?? 0).toBeGreaterThan(0);

      walk((command.data as { options?: OptionLike[] }).options, (option) => {
        expect(option.name, `${command.name}.${option.name}`).toMatch(
          /^[a-z][a-z0-9_-]{0,31}$/,
        );
        expect(
          option.description.length,
          `${command.name}.${option.name} description`,
        ).toBeLessThanOrEqual(100);
        expect(option.choices?.length ?? 0).toBeLessThanOrEqual(25);
      });
    }
  });

  /**
   * Discord's least-known limit, and the one this bot is heading towards.
   *
   * A command's names, descriptions and choice values must total under 8,000
   * characters ACROSS its whole tree. `/level` alone is a third of the way
   * there after M15, and the failure is a 400 at boot with a message that
   * points at a JSON path rather than at the subcommand that tipped it over.
   */
  it('keeps each command under Discord’s 8,000-character total', () => {
    interface Sizeable {
      name?: string | undefined;
      description?: string | undefined;
      options?: Sizeable[] | undefined;
      choices?: { name: string; value: string | number }[] | undefined;
    }

    const size = (node: Sizeable): number => {
      let total = (node.name?.length ?? 0) + (node.description?.length ?? 0);
      for (const option of node.options ?? []) total += size(option);
      for (const choice of node.choices ?? []) {
        total += choice.name.length + String(choice.value).length;
      }
      return total;
    };

    for (const command of commands) {
      expect(size(command.data as Sizeable), command.name).toBeLessThan(8_000);
    }
  });

  /**
   * THE ONE THAT SHIPPED BROKEN, TWICE OVER NOW.
   *
   * Discord requires every required option to precede every optional one, and
   * rejects the ENTIRE command set with a 400 if any single subcommand gets it
   * wrong — so one misordered option takes the whole bot down at boot, in front
   * of whoever is running it, with an error that names a JSON index rather than
   * a subcommand. discord.js does not check this when building the payload.
   *
   * `/xp forget` had `user` (optional) before `confirm` (required) and failed
   * exactly that way. Asserted here for every option list in the module.
   */
  it('puts every required option before every optional one', () => {
    const check = (options: OptionLike[] | undefined, path: string): void => {
      let seenOptional: string | null = null;
      for (const option of options ?? []) {
        // Subcommands and groups (types 1 and 2) carry no `required` flag and
        // are ordered freely; recurse into them and skip the check itself.
        if (option.type === 1 || option.type === 2) {
          check(option.options, `${path} ${option.name}`);
          continue;
        }
        if (option.required === true && seenOptional !== null) {
          throw new Error(
            `${path}: required option "${option.name}" comes after optional ` +
              `"${seenOptional}". Discord refuses the whole command set for this.`,
          );
        }
        if (option.required !== true) seenOptional = option.name;
      }
    };

    for (const command of commands) {
      expect(() =>
        check((command.data as { options?: OptionLike[] }).options, `/${command.name}`),
      ).not.toThrow();
    }
  });

  it('never exceeds 25 options at any one level', () => {
    for (const command of commands) {
      const top = (command.data as { options?: OptionLike[] }).options ?? [];
      expect(top.length, command.name).toBeLessThanOrEqual(25);
      walk(top, (option) => {
        expect(option.options?.length ?? 0).toBeLessThanOrEqual(25);
      });
    }
  });

  it('gives the settings key an autocomplete handler, since it has hundreds of values', () => {
    const level = commands.find((c) => c.name === 'level');
    let found = false;
    walk((level?.data as { options?: OptionLike[] }).options, (option) => {
      if (option.name === 'key' && option.autocomplete === true) found = true;
    });
    expect(found).toBe(true);
    expect(level?.autocomplete).toBeTypeOf('function');
  });

  it('defers every command, because they all touch the database', () => {
    for (const command of commands) {
      expect(command.defer, command.name).toBe(true);
    }
  });

  it('answers admin commands ephemerally and member commands in channel', () => {
    // `/card` joins the admin commands here for a different reason: it is a
    // member's own settings, and a preview of your own card does not belong in
    // everyone else's chat. `/rank` and `/leaderboard` stay public because the
    // whole point of them is being seen.
    const ephemeral = commands.filter((c) => c.ephemeral).map((c) => c.name);
    expect(ephemeral.sort()).toEqual(['card', 'level', 'xp']);
  });

  it('claims a distinct component prefix per interactive surface', () => {
    // Prefixes are how the dispatcher routes a button press, so two handlers
    // sharing one would mean the second is unreachable — silently.
    const prefixes = (module_.components ?? []).map((c) => c.customIdPrefix);
    expect(prefixes.sort()).toEqual(['lb', 'rwbf']);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it('requests MessageContent only when asked', () => {
    const without = createLevelingModule({ requestMessageContent: false });
    expect(without.requiredIntents.length).toBe(module_.requiredIntents.length - 1);
  });
});

describe('lazy initialisation', () => {
  it('fails loudly if a handler runs before init', async () => {
    // The commands exist before `init` because they are registered with Discord
    // over REST first. Reading a service early must throw a clear message rather
    // than producing `undefined` deep inside a handler.
    const fresh = createLevelingModule({ requestMessageContent: false });
    const rank = fresh.commands?.find((c) => c.name === 'rank');

    await expect(
      rank?.execute(
        {
          inGuild: () => true,
          guildId: '1',
          options: { getUser: () => null },
          user: { id: '2' },
        } as never,
        {} as never,
      ),
    ).rejects.toThrow(/before init/);
  });
});

describe('leaderboard button custom ids', () => {
  /**
   * Discord requires every custom id in a message to be unique and rejects the
   * whole message with 50035 otherwise — but discord.js does not check it, so
   * the payload serialises perfectly and the API is the first thing to object.
   *
   * This shipped broken: encoding only the destination page made First and Last
   * identical on a one-page board, which is what every new server sees, so
   * /leaderboard failed on its very first use.
   */
  const page = (p: number, totalPages: number): LeaderboardPage => ({
    metric: 'xp',
    entries: [],
    page: p,
    pageSize: 10,
    totalRanked: 0,
    totalPages,
  });

  it('are unique on a one-page board', () => {
    const ids = customIdsFor(page(1, 1), '222222222222222222');
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('are unique for every page of every board size up to 5 pages', () => {
    for (let totalPages = 1; totalPages <= 5; totalPages++) {
      for (let current = 1; current <= totalPages; current++) {
        const ids = customIdsFor(page(current, totalPages), '222222222222222222');
        expect(
          new Set(ids).size,
          `page ${current} of ${totalPages}: ${ids.join(' | ')}`,
        ).toBe(ids.length);
      }
    }
  });

  it('stay inside Discord’s 100-character custom id limit', () => {
    const ids = customIdsFor(page(999_999, 999_999), '222222222222222222');
    for (const id of ids) expect(id.length).toBeLessThanOrEqual(100);
  });

  it('never point at page zero', () => {
    // A "Prev" from page 1 is disabled, but a disabled button still carries its
    // id, and an id that decodes to page 0 would be a confusing thing to log.
    const ids = customIdsFor(page(1, 3), '222222222222222222');
    for (const id of ids) expect(id).not.toMatch(/:0:/);
  });
});
