import {
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { CommandDefinition, ModuleContext } from '../../../../platform/plugin/types.js';
import {
  describeAccepted,
  findSetting,
  parseSettingValue,
  searchSettings,
  SETTINGS,
  SETTING_GROUPS,
  type SettingDefinition,
} from '../../application/settings/registry.js';
import { validateTemplate } from '../../domain/notifications/template.js';
import type { GuildLevelingConfig, XpRule } from '../../domain/types.js';
import type {
  AuditRepository,
  ConfigCache,
  ConfigRepository,
  RuleRepository,
} from '../../ports/config.js';
import { formatNumber } from './format.js';
import { handleDebug, type LevelDebugDeps } from './levelDebug.js';
import { handleBackfill, type BackfillCommandDeps } from './rewardBackfill.js';

/**
 * `/level` — the whole admin surface (spec `03` §4.2, M5).
 *
 * ONE command with subcommand groups rather than forty commands, for three
 * reasons: Discord caps a command at 25 options; a single `/level` is what an
 * admin can actually find; and every write funnels through one place where the
 * permission check, the cache invalidation and the audit entry happen together.
 *
 * PERMISSIONS ARE RE-CHECKED HERE. `setDefaultMemberPermissions` is a UI hint
 * that a server admin can override in Integrations settings — trusting it means
 * an admin can accidentally expose the entire configuration surface to everyone.
 */

export interface LevelAdminDeps extends LevelDebugDeps, BackfillCommandDeps {
  readonly config: ConfigRepository;
  readonly rules: RuleRepository;
  readonly audit: AuditRepository;
  readonly configs: ConfigCache;
}

export function createLevelCommand(deps: LevelAdminDeps): CommandDefinition {
  return {
    name: 'level',
    defer: true,
    ephemeral: true,
    data: buildData(),

    async autocomplete(interaction: AutocompleteInteraction) {
      const focused = interaction.options.getFocused(true);
      if (focused.name !== 'key') {
        await interaction.respond([]);
        return;
      }
      // Answered entirely from the in-memory registry — Discord allows three
      // seconds and no deferral, so this must never touch the database.
      await interaction.respond(
        searchSettings(focused.value).map((setting) => ({
          // The description is the useful half; Discord shows 100 characters.
          name: `${setting.key} — ${setting.description}`.slice(0, 100),
          value: setting.key,
        })),
      );
    },

    async execute(interaction: ChatInputCommandInteraction, ctx) {
      if (!interaction.guildId || !interaction.inGuild()) {
        await interaction.editReply('This command only works inside a server.');
        return;
      }

      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        await interaction.editReply(
          'You need the **Manage Server** permission to change leveling settings.',
        );
        return;
      }

      const group = interaction.options.getSubcommandGroup(false);
      const sub = interaction.options.getSubcommand();

      switch (`${group ?? ''}/${sub}`) {
        case 'config/view':
          return viewConfig(interaction, deps);
        case 'config/set':
          return setConfig(interaction, deps, ctx);
        case 'config/reset':
          return resetConfig(interaction, deps, ctx);
        case 'restrict/add':
          return addRestriction(interaction, deps, ctx);
        case 'restrict/remove':
          return removeRestriction(interaction, deps, ctx);
        case 'restrict/list':
          return listRules(interaction, deps);
        case 'boost/add':
          return addBoost(interaction, deps, ctx);
        case 'boost/remove':
          return removeBoost(interaction, deps, ctx);
        case 'reward/add':
          return addReward(interaction, deps, ctx);
        case 'reward/add-recurring':
          return addRecurringReward(interaction, deps, ctx);
        case 'reward/remove':
          return removeReward(interaction, deps, ctx);
        case 'reward/remove-recurring':
          return removeRecurringReward(interaction, deps, ctx);
        case 'reward/list':
          return listRewards(interaction, deps);
        case 'reward/backfill':
          return handleBackfill(interaction, deps, ctx);
        case 'debug/why':
        case 'debug/member':
        case 'debug/rewards':
        case 'debug/health':
          return handleDebug(interaction, deps, ctx, sub);
        default:
          await interaction.editReply('Unknown subcommand.');
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Command shape
// ---------------------------------------------------------------------------

function buildData() {
  return new SlashCommandBuilder()
    .setName('level')
    .setDescription('Configure the leveling system')
    .setDMPermission(false)
    // A hint to Discord's UI. The real check is in execute() — see the header.
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)

    .addSubcommandGroup((group) =>
      group
        .setName('config')
        .setDescription('View and change settings')
        .addSubcommand((sub) =>
          sub
            .setName('view')
            .setDescription('Show the current configuration')
            .addStringOption((option) =>
              option
                .setName('group')
                .setDescription('Only show one group of settings')
                .addChoices(
                  ...SETTING_GROUPS.slice(0, 25).map((g) => ({ name: g, value: g })),
                ),
            ),
        )
        .addSubcommand((sub) =>
          sub
            .setName('set')
            .setDescription('Change one setting')
            .addStringOption((option) =>
              option
                .setName('key')
                .setDescription('Which setting to change')
                .setRequired(true)
                .setAutocomplete(true),
            )
            .addStringOption((option) =>
              option
                .setName('value')
                .setDescription('The new value (on/off, a number, or text)')
                .setRequired(true),
            ),
        )
        .addSubcommand((sub) =>
          sub
            .setName('reset')
            .setDescription('Reset every setting to its default')
            .addBooleanOption((option) =>
              option
                .setName('confirm')
                .setDescription('This cannot be undone. Set to true to proceed.')
                .setRequired(true),
            ),
        ),
    )

    .addSubcommandGroup((group) =>
      group
        .setName('restrict')
        .setDescription('Control where and for whom XP is earned')
        .addSubcommand((sub) =>
          sub
            .setName('add')
            .setDescription('Block XP somewhere, or allow it ONLY somewhere')
            .addStringOption((option) =>
              option
                .setName('mode')
                .setDescription('deny: earn nothing here. only: earn nowhere else.')
                .setRequired(true)
                .addChoices(
                  { name: 'deny — no XP here', value: 'restrict_deny' },
                  { name: 'only — XP only here', value: 'restrict_only' },
                ),
            )
            .addChannelOption((option) =>
              option.setName('channel').setDescription('A channel or category'),
            )
            .addRoleOption((option) => option.setName('role').setDescription('A role'))
            .addUserOption((option) => option.setName('user').setDescription('A single member')),
        )
        .addSubcommand((sub) =>
          sub
            .setName('remove')
            .setDescription('Remove a restriction')
            .addStringOption((option) =>
              option
                .setName('mode')
                .setDescription('Which kind of restriction to remove')
                .setRequired(true)
                .addChoices(
                  { name: 'deny', value: 'restrict_deny' },
                  { name: 'only', value: 'restrict_only' },
                ),
            )
            .addChannelOption((option) =>
              option.setName('channel').setDescription('A channel or category'),
            )
            .addRoleOption((option) => option.setName('role').setDescription('A role'))
            .addUserOption((option) => option.setName('user').setDescription('A single member')),
        )
        .addSubcommand((sub) =>
          sub.setName('list').setDescription('List all restrictions and boosters'),
        ),
    )

    .addSubcommandGroup((group) =>
      group
        .setName('boost')
        .setDescription('Extra XP for a role or channel')
        .addSubcommand((sub) =>
          sub
            .setName('add')
            .setDescription('Give a role or channel bonus XP')
            .addIntegerOption((option) =>
              option
                .setName('percent')
                .setDescription('Bonus percent. 50 = +50%. Negative values reduce XP.')
                .setRequired(true)
                .setMinValue(-100)
                .setMaxValue(1000),
            )
            .addRoleOption((option) => option.setName('role').setDescription('A role'))
            .addChannelOption((option) =>
              option.setName('channel').setDescription('A channel or category'),
            )
            .addIntegerOption((option) =>
              option
                .setName('hours')
                .setDescription('Make it temporary: expire after this many hours')
                .setMinValue(1)
                .setMaxValue(8760),
            ),
        )
        .addSubcommand((sub) =>
          sub
            .setName('remove')
            .setDescription('Remove a booster')
            .addRoleOption((option) => option.setName('role').setDescription('A role'))
            .addChannelOption((option) =>
              option.setName('channel').setDescription('A channel or category'),
            ),
        ),
    )

    .addSubcommandGroup((group) =>
      group
        .setName('reward')
        .setDescription('Roles granted at a level')
        .addSubcommand((sub) =>
          sub
            .setName('add')
            .setDescription('Grant a role when a member reaches a level')
            .addIntegerOption((option) =>
              option
                .setName('level')
                .setDescription('The level that grants it')
                .setRequired(true)
                .setMinValue(1)
                .setMaxValue(100_000),
            )
            .addRoleOption((option) =>
              option.setName('role').setDescription('The role to grant').setRequired(true),
            ),
        )
        .addSubcommand((sub) =>
          sub
            .setName('add-recurring')
            .setDescription('Grant a role at a level, and again every N levels')
            .addRoleOption((option) =>
              option.setName('role').setDescription('The role to grant').setRequired(true),
            )
            .addIntegerOption((option) =>
              option
                .setName('start')
                .setDescription('The first level that grants it')
                .setRequired(true)
                .setMinValue(1)
                .setMaxValue(100_000),
            )
            .addIntegerOption((option) =>
              option
                .setName('every')
                .setDescription('Levels between repeats')
                .setRequired(true)
                .setMinValue(1)
                .setMaxValue(100_000),
            ),
        )
        .addSubcommand((sub) =>
          sub
            .setName('remove')
            .setDescription('Stop granting a role')
            .addIntegerOption((option) =>
              option
                .setName('level')
                .setDescription('The level to clear')
                .setRequired(true)
                .setMinValue(0),
            )
            .addRoleOption((option) =>
              option.setName('role').setDescription('Only this role (default: all at that level)'),
            ),
        )
        .addSubcommand((sub) =>
          sub
            .setName('remove-recurring')
            .setDescription('Remove a recurring reward rule')
            .addRoleOption((option) =>
              option.setName('role').setDescription('Only this role (default: all recurring rules)'),
            ),
        )
        .addSubcommand((sub) => sub.setName('list').setDescription('List reward roles'))
        .addSubcommand((sub) =>
          sub
            .setName('backfill')
            .setDescription('Give everyone the reward roles their level already earned')
            .addBooleanOption((option) =>
              option
                .setName('apply')
                .setDescription('Actually change roles (default: show what would change)'),
            )
            .addBooleanOption((option) =>
              option
                .setName('include-departed')
                .setDescription('Also visit members who have left the server'),
            ),
        ),
    )

    .addSubcommandGroup((group) =>
      group
        .setName('debug')
        .setDescription('Work out why something is or is not happening')
        .addSubcommand((sub) =>
          sub
            .setName('why')
            .setDescription('Simulate a message and show every gate it passes or fails')
            .addUserOption((option) =>
              option.setName('user').setDescription('Who to simulate (defaults to you)'),
            )
            .addChannelOption((option) =>
              option
                .setName('channel')
                .setDescription('Where to simulate it (defaults to here)')
                .addChannelTypes(
                  ChannelType.GuildText,
                  ChannelType.GuildAnnouncement,
                  ChannelType.PublicThread,
                  ChannelType.PrivateThread,
                  ChannelType.GuildVoice,
                ),
            ),
        )
        .addSubcommand((sub) =>
          sub
            .setName('member')
            .setDescription('Everything stored about one member')
            .addUserOption((option) =>
              option.setName('user').setDescription('Who (defaults to you)'),
            ),
        )
        .addSubcommand((sub) =>
          sub
            .setName('rewards')
            .setDescription('What reward roles a member should hold, and what is blocking them')
            .addUserOption((option) =>
              option.setName('user').setDescription('Who (defaults to you)'),
            ),
        )
        .addSubcommand((sub) =>
          sub.setName('health').setDescription('Everything wrong with this server’s setup'),
        ),
    )
    .toJSON();
}

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

async function viewConfig(
  interaction: ChatInputCommandInteraction,
  deps: LevelAdminDeps,
): Promise<void> {
  const guildId = interaction.guildId as string;
  const config = await deps.configs.get(guildId);
  const wanted = interaction.options.getString('group');

  const shown = SETTINGS.filter((s) => groupOf(s) === (wanted ?? groupOf(s)));

  const embed = new EmbedBuilder()
    .setTitle(wanted ? `Leveling settings — ${wanted}` : 'Leveling settings')
    .setDescription(
      config.enabled
        ? 'Leveling is **on**.'
        : 'Leveling is **off** — run `/level config set enabled on`.',
    );

  // Grouped into fields, because thirty lines of `key: value` is unreadable and
  // Discord caps a field at 1024 characters anyway.
  for (const [group, settings] of byGroup(shown)) {
    embed.addFields({
      name: group,
      value: settings
        .map((s) => `\`${s.key}\` — ${safeRead(s, config)}`)
        .join('\n')
        .slice(0, 1024),
    });
    if ((embed.data.fields?.length ?? 0) >= 25) break;
  }

  embed.setFooter({
    text: 'Change one with /level config set <key> <value>',
  });

  await interaction.editReply({ embeds: [embed] });
}

async function setConfig(
  interaction: ChatInputCommandInteraction,
  deps: LevelAdminDeps,
  ctx: ModuleContext,
): Promise<void> {
  const guildId = interaction.guildId as string;
  const key = interaction.options.getString('key', true);
  const raw = interaction.options.getString('value', true);

  // The registry is the whitelist: an unknown key never reaches SQL.
  const setting = findSetting(key);
  if (!setting) {
    const suggestions = searchSettings(key, 5)
      .map((s) => `\`${s.key}\``)
      .join(', ');
    await interaction.editReply(
      `There is no setting called \`${key}\`.` +
        (suggestions ? ` Did you mean ${suggestions}?` : ''),
    );
    return;
  }

  const parsed = parseSettingValue(setting, raw);
  if (!parsed.ok) {
    await interaction.editReply(
      `\`${setting.key}\` ${parsed.error}.\nIt accepts ${describeAccepted(setting)}.`,
    );
    return;
  }

  const before = await deps.configs.get(guildId);
  const previous = safeRead(setting, before);

  if (setting.source) {
    await deps.config.updateSource(guildId, setting.source, { [setting.column]: parsed.value });
  } else {
    await deps.config.update(guildId, { [setting.column]: parsed.value }, interaction.user.id);
  }

  // Invalidate on the SAME path as the write. The version check in the cache is
  // a safety net, not the mechanism.
  deps.configs.invalidate(guildId);

  await deps.audit.record(guildId, {
    actorId: interaction.user.id,
    action: `config.set:${setting.key}`,
    before: previous,
    after: String(parsed.value),
  });

  const after = await deps.configs.get(guildId);
  const warnings = collectWarnings(setting, raw, after);

  ctx.log.info(
    { guildId, key: setting.key, actor: interaction.user.id },
    'leveling setting changed',
  );

  await interaction.editReply(
    `**${setting.key}** is now ${safeRead(setting, after)} (was ${previous}).` +
      (warnings.length > 0 ? `\n\n⚠️ ${warnings.join('\n⚠️ ')}` : ''),
  );
}

/**
 * Things that are legal but probably not what the admin meant. Surfaced as
 * warnings rather than refusals — a bot that argues with a valid instruction is
 * worse than one that says "are you sure".
 */
function collectWarnings(
  setting: SettingDefinition,
  raw: string,
  config: GuildLevelingConfig,
): string[] {
  const warnings: string[] = [];

  if (setting.key === 'levelup.template') {
    for (const issue of validateTemplate(raw)) {
      if (issue.kind !== 'empty' && issue.kind !== 'too_long') warnings.push(issue.detail);
    }
  }

  if (setting.key === 'levelup.mode' && config.notifications.mode === 'fixed_channel') {
    if (!config.notifications.channelId) {
      warnings.push('No channel is set yet — run `/level config set levelup.channel #channel`.');
    }
  }

  if (setting.source && (setting.key.endsWith('.xpMin') || setting.key.endsWith('.xpMax'))) {
    const source = config.sources[setting.source];
    if (source.minXp > source.maxXp) {
      warnings.push(
        `xpMin (${source.minXp}) is above xpMax (${source.maxXp}); no XP will be awarded ` +
          'until that is fixed.',
      );
    }
  }

  if (setting.key === 'context.minMessageLength' && config.context.minMessageLength > 0) {
    warnings.push('This needs the Message Content intent to have any effect.');
  }
  if (setting.key === 'effort.enabled' && config.effort.enabled) {
    warnings.push('The effort bonus needs the Message Content intent to have any effect.');
  }

  return warnings;
}

async function resetConfig(
  interaction: ChatInputCommandInteraction,
  deps: LevelAdminDeps,
  ctx: ModuleContext,
): Promise<void> {
  const guildId = interaction.guildId as string;

  if (!interaction.options.getBoolean('confirm', true)) {
    await interaction.editReply(
      'Nothing changed. Run it again with `confirm: True` if you really want to reset every setting.',
    );
    return;
  }

  await deps.config.resetToDefaults(guildId);
  deps.configs.invalidate(guildId);
  await deps.audit.record(guildId, {
    actorId: interaction.user.id,
    action: 'config.reset',
  });

  ctx.log.warn({ guildId, actor: interaction.user.id }, 'leveling config reset to defaults');
  await interaction.editReply(
    'Every setting is back to its default. **Member XP was not touched** — ' +
      'this only reset configuration.',
  );
}

// ---------------------------------------------------------------------------
// restrictions and boosters
// ---------------------------------------------------------------------------

interface Target {
  readonly targetType: XpRule['targetType'];
  readonly targetId: string;
  readonly mention: string;
}

/** Exactly one of channel/role/user, resolved to a rule target. */
function resolveTarget(interaction: ChatInputCommandInteraction): Target | string {
  const channel = interaction.options.getChannel('channel');
  const role = interaction.options.getRole('role');
  const user = interaction.options.getUser('user');

  const provided = [channel, role, user].filter((v) => v !== null);
  if (provided.length === 0) return 'Pick a channel, a role or a user.';
  if (provided.length > 1) return 'Pick just one of channel, role or user.';

  if (channel) {
    // A category restriction covers everything inside it, which is the whole
    // reason the location chain walks upward.
    const isCategory = channel.type === ChannelType.GuildCategory;
    return {
      targetType: isCategory ? 'category' : 'channel',
      targetId: channel.id,
      mention: isCategory ? `category **${channel.name}**` : `<#${channel.id}>`,
    };
  }
  if (role) return { targetType: 'role', targetId: role.id, mention: `<@&${role.id}>` };
  if (user) return { targetType: 'user', targetId: user.id, mention: `<@${user.id}>` };
  return 'Pick a channel, a role or a user.';
}

async function addRestriction(
  interaction: ChatInputCommandInteraction,
  deps: LevelAdminDeps,
  ctx: ModuleContext,
): Promise<void> {
  const guildId = interaction.guildId as string;
  const kind = interaction.options.getString('mode', true) as 'restrict_deny' | 'restrict_only';
  const target = resolveTarget(interaction);
  if (typeof target === 'string') {
    await interaction.editReply(target);
    return;
  }

  await deps.rules.addRule(
    guildId,
    { kind, targetType: target.targetType, targetId: target.targetId },
    interaction.user.id,
  );
  deps.configs.invalidate(guildId);
  await deps.audit.record(guildId, {
    actorId: interaction.user.id,
    action: `restrict.add:${kind}`,
    after: { targetType: target.targetType, targetId: target.targetId },
  });

  ctx.log.info({ guildId, kind, target: target.targetId }, 'restriction added');

  const config = await deps.configs.get(guildId);
  const onlyCount = config.rules.filter((r) => r.kind === 'restrict_only').length;

  await interaction.editReply(
    kind === 'restrict_deny'
      ? `No XP will be earned in ${target.mention}.`
      : `XP is now earned **only** in ${target.mention}` +
          (onlyCount > 1 ? ` and ${onlyCount - 1} other allowed place(s).` : '.') +
          '\n\n⚠️ An "only" rule turns everywhere else off. Remove it with ' +
          '`/level restrict remove mode:only`.',
  );
}

async function removeRestriction(
  interaction: ChatInputCommandInteraction,
  deps: LevelAdminDeps,
  ctx: ModuleContext,
): Promise<void> {
  const guildId = interaction.guildId as string;
  const kind = interaction.options.getString('mode', true) as 'restrict_deny' | 'restrict_only';
  const target = resolveTarget(interaction);
  if (typeof target === 'string') {
    await interaction.editReply(target);
    return;
  }

  const removed = await deps.rules.removeRule(guildId, kind, target.targetType, target.targetId);
  deps.configs.invalidate(guildId);

  if (removed === 0) {
    await interaction.editReply(`There was no such restriction on ${target.mention}.`);
    return;
  }

  await deps.audit.record(guildId, {
    actorId: interaction.user.id,
    action: `restrict.remove:${kind}`,
    before: { targetType: target.targetType, targetId: target.targetId },
  });
  ctx.log.info({ guildId, kind, target: target.targetId }, 'restriction removed');
  await interaction.editReply(`Removed. ${target.mention} follows the normal rules again.`);
}

async function addBoost(
  interaction: ChatInputCommandInteraction,
  deps: LevelAdminDeps,
  ctx: ModuleContext,
): Promise<void> {
  const guildId = interaction.guildId as string;
  const percent = interaction.options.getInteger('percent', true);
  const hours = interaction.options.getInteger('hours');
  const target = resolveTarget(interaction);
  if (typeof target === 'string') {
    await interaction.editReply(target);
    return;
  }

  const expiresAt = hours === null ? null : Date.now() + hours * 3_600_000;

  await deps.rules.addRule(
    guildId,
    {
      kind: 'boost',
      targetType: target.targetType,
      targetId: target.targetId,
      bonusBps: percent * 100,
      expiresAt,
    },
    interaction.user.id,
  );
  deps.configs.invalidate(guildId);
  await deps.audit.record(guildId, {
    actorId: interaction.user.id,
    action: 'boost.add',
    after: { targetId: target.targetId, percent, hours },
  });

  ctx.log.info({ guildId, target: target.targetId, percent }, 'booster added');

  const config = await deps.configs.get(guildId);
  const denied = config.rules.some(
    (r) => r.kind === 'restrict_deny' && r.targetId === target.targetId,
  );

  await interaction.editReply(
    `${target.mention} now earns ${percent >= 0 ? '+' : ''}${percent}% XP` +
      (expiresAt ? `, expiring <t:${Math.floor(expiresAt / 1000)}:R>.` : '.') +
      // The pipeline is explicit that restrictions beat boosters; saying so here
      // saves an admin from debugging a booster that can never fire.
      (denied
        ? '\n\n⚠️ That target is also on the no-XP list, and a restriction always ' +
          'wins — this booster will never apply.'
        : ''),
  );
}

async function removeBoost(
  interaction: ChatInputCommandInteraction,
  deps: LevelAdminDeps,
  ctx: ModuleContext,
): Promise<void> {
  const guildId = interaction.guildId as string;
  const target = resolveTarget(interaction);
  if (typeof target === 'string') {
    await interaction.editReply(target);
    return;
  }

  const removed = await deps.rules.removeRule(guildId, 'boost', target.targetType, target.targetId);
  deps.configs.invalidate(guildId);

  if (removed === 0) {
    await interaction.editReply(`${target.mention} has no booster.`);
    return;
  }

  await deps.audit.record(guildId, {
    actorId: interaction.user.id,
    action: 'boost.remove',
    before: { targetId: target.targetId },
  });
  ctx.log.info({ guildId, target: target.targetId }, 'booster removed');
  await interaction.editReply(`Booster removed from ${target.mention}.`);
}

async function listRules(
  interaction: ChatInputCommandInteraction,
  deps: LevelAdminDeps,
): Promise<void> {
  const config = await deps.configs.get(interaction.guildId as string);

  const deny = config.rules.filter((r) => r.kind === 'restrict_deny');
  const only = config.rules.filter((r) => r.kind === 'restrict_only');
  const boosts = config.rules.filter((r) => r.kind === 'boost');

  const embed = new EmbedBuilder().setTitle('Restrictions and boosters');

  embed.addFields(
    {
      name: `No XP (${deny.length})`,
      value: deny.length === 0 ? '*none*' : deny.map(describeRule).join('\n').slice(0, 1024),
    },
    {
      name: `XP only in (${only.length})`,
      value:
        only.length === 0
          ? '*none — XP is earned everywhere else allows*'
          : only.map(describeRule).join('\n').slice(0, 1024),
    },
    {
      name: `Boosters (${boosts.length})`,
      value: boosts.length === 0 ? '*none*' : boosts.map(describeRule).join('\n').slice(0, 1024),
    },
  );

  if (only.length > 0 && deny.length > 0) {
    embed.setFooter({
      text: 'Both lists are in use. A "no XP" rule always beats an "only" rule.',
    });
  }

  await interaction.editReply({ embeds: [embed] });
}

function describeRule(rule: XpRule): string {
  const target =
    rule.targetType === 'role'
      ? `<@&${rule.targetId}>`
      : rule.targetType === 'user'
        ? `<@${rule.targetId}>`
        : rule.targetType === 'guild'
          ? 'the whole server'
          : `<#${rule.targetId}>`;

  const bonus =
    rule.bonusBps === undefined
      ? ''
      : ` — ${rule.bonusBps >= 0 ? '+' : ''}${rule.bonusBps / 100}%`;
  const expiry =
    rule.expiresAt == null ? '' : ` (expires <t:${Math.floor(rule.expiresAt / 1000)}:R>)`;
  const scope = rule.sourceScope ? ` [${rule.sourceScope} only]` : '';

  return `${target}${bonus}${scope}${expiry}`;
}

// ---------------------------------------------------------------------------
// rewards
// ---------------------------------------------------------------------------

/**
 * Why this role cannot be a reward, or null.
 *
 * Checked BEFORE storing, because a rule the bot can never apply is worse than
 * a refusal: it looks configured and silently does nothing. Shared by both the
 * exact and the recurring rule, which is the point of extracting it — the
 * `@everyone` bug that shipped in M7 was one branch missing from one path.
 */
function whyUnusableAsReward(
  interaction: ChatInputCommandInteraction,
  roleId: string,
): string | null {
  const guildId = interaction.guildId as string;
  const me = interaction.guild?.members.me;
  const guildRole = interaction.guild?.roles.cache.get(roleId);

  // @everyone. Its id is the guild's id, every member already has it, and
  // Discord rejects adding or removing it — but it sits at position 0, so the
  // hierarchy check below would happily accept it.
  if (roleId === guildId) {
    return (
      '`@everyone` cannot be a reward: every member already has it and Discord ' +
      'does not allow it to be granted or removed.\n' +
      'Create a normal role for the reward, and make sure my own role sits above it.'
    );
  }

  if (guildRole?.managed) {
    return (
      `**${guildRole.name}** is managed by an integration (a bot, Nitro Boost, or a ` +
      'subscription), and Discord does not allow anyone to assign it.'
    );
  }
  if (me && guildRole && guildRole.position >= me.roles.highest.position) {
    return (
      `I cannot grant **${guildRole.name}** because it sits above my own highest role.\n` +
      'Move my role above it in **Server Settings → Roles**, then run this again.'
    );
  }
  if (me && !me.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return 'I need the **Manage Roles** permission before I can grant reward roles.';
  }
  return null;
}

async function addReward(
  interaction: ChatInputCommandInteraction,
  deps: LevelAdminDeps,
  ctx: ModuleContext,
): Promise<void> {
  const guildId = interaction.guildId as string;
  const level = interaction.options.getInteger('level', true);
  const role = interaction.options.getRole('role', true);

  const problem = whyUnusableAsReward(interaction, role.id);
  if (problem) {
    await interaction.editReply(problem);
    return;
  }

  await deps.rules.addReward(guildId, level, role.id, interaction.user.id);
  deps.configs.invalidate(guildId);
  await deps.audit.record(guildId, {
    actorId: interaction.user.id,
    action: 'reward.add',
    after: { level, roleId: role.id },
  });

  ctx.log.info({ guildId, level, roleId: role.id }, 'reward role added');

  const config = await deps.configs.get(guildId);
  await interaction.editReply(
    `Members reaching level ${formatNumber(level)} will get <@&${role.id}>.` +
      (config.rewardStacking === 'highest'
        ? '\n\nStacking is set to **highest**, so this replaces lower reward roles.'
        : ''),
  );
}

async function removeReward(
  interaction: ChatInputCommandInteraction,
  deps: LevelAdminDeps,
  ctx: ModuleContext,
): Promise<void> {
  const guildId = interaction.guildId as string;
  const level = interaction.options.getInteger('level', true);
  const role = interaction.options.getRole('role');

  const removed = await deps.rules.removeReward(guildId, level, role?.id);
  deps.configs.invalidate(guildId);

  if (removed === 0) {
    await interaction.editReply(`Nothing is granted at level ${formatNumber(level)}.`);
    return;
  }

  await deps.audit.record(guildId, {
    actorId: interaction.user.id,
    action: 'reward.remove',
    before: { level, roleId: role?.id ?? null },
  });
  ctx.log.info({ guildId, level }, 'reward role removed');

  await interaction.editReply(
    `Removed ${removed} reward rule(s) at level ${formatNumber(level)}.\n` +
      'Members who already hold the role keep it until their roles are next reconciled.',
  );
}

/**
 * `/level reward add-recurring` — "…and again every N levels".
 *
 * Arcane parity, and the reason it is worth having: a server that wants a role
 * at 5, 10, 15, 20 … up to 100 otherwise needs twenty rules, each of which is a
 * row an admin has to remember to extend when someone finally gets there.
 *
 * Because it is ONE role granted repeatedly, the member simply holds it from
 * the start level onwards; the step decides where the rule ranks when stacking
 * is `highest`. The reply says so, because "every 10 levels" sounds like it
 * ought to do something visible at each iteration.
 */
async function addRecurringReward(
  interaction: ChatInputCommandInteraction,
  deps: LevelAdminDeps,
  ctx: ModuleContext,
): Promise<void> {
  const guildId = interaction.guildId as string;
  const everyN = interaction.options.getInteger('every', true);
  const startLevel = interaction.options.getInteger('start', true);
  const role = interaction.options.getRole('role', true);

  const problem = whyUnusableAsReward(interaction, role.id);
  if (problem) {
    await interaction.editReply(problem);
    return;
  }

  await deps.rules.addRecurringReward(guildId, everyN, startLevel, role.id, interaction.user.id);
  deps.configs.invalidate(guildId);
  await deps.audit.record(guildId, {
    actorId: interaction.user.id,
    action: 'reward.add_recurring',
    after: { everyN, startLevel, roleId: role.id },
  });

  ctx.log.info({ guildId, everyN, startLevel, roleId: role.id }, 'recurring reward added');

  const config = await deps.configs.get(guildId);
  await interaction.editReply(
    `<@&${role.id}> is now granted at level ${formatNumber(startLevel)}, and again every ` +
      `${formatNumber(everyN)} levels after that.\n` +
      'Since it is the same role each time, members simply keep it once they reach ' +
      `level ${formatNumber(startLevel)}.` +
      (config.rewardStacking === 'highest'
        ? '\n\nStacking is **highest**, so each iteration re-establishes this role as ' +
          'the top one — which is what makes a recurring rule useful in that mode.'
        : ''),
  );
}

async function removeRecurringReward(
  interaction: ChatInputCommandInteraction,
  deps: LevelAdminDeps,
  ctx: ModuleContext,
): Promise<void> {
  const guildId = interaction.guildId as string;
  const role = interaction.options.getRole('role');

  const removed = await deps.rules.removeRecurringReward(guildId, role?.id);
  deps.configs.invalidate(guildId);

  if (removed === 0) {
    await interaction.editReply(
      role ? `<@&${role.id}> has no recurring rule.` : 'There are no recurring reward rules.',
    );
    return;
  }

  await deps.audit.record(guildId, {
    actorId: interaction.user.id,
    action: 'reward.remove_recurring',
    before: { roleId: role?.id ?? null },
  });
  ctx.log.info({ guildId, roleId: role?.id ?? null }, 'recurring reward removed');

  await interaction.editReply(
    `Removed ${removed} recurring rule(s).\n` +
      'Members who already hold the role keep it until their roles are next reconciled.',
  );
}

async function listRewards(
  interaction: ChatInputCommandInteraction,
  deps: LevelAdminDeps,
): Promise<void> {
  const guildId = interaction.guildId as string;
  const rewards = await deps.rules.listRewards(guildId);

  if (rewards.length === 0) {
    await interaction.editReply(
      'No reward roles yet. Add one with `/level reward add level:10 role:@Regular`.',
    );
    return;
  }

  const describe = (r: { type: string; level: number; everyN: number | null }): string =>
    r.type === 'recurring'
      ? `Level ${formatNumber(r.level)}, then every ${formatNumber(r.everyN ?? 1)}`
      : `Level ${formatNumber(r.level)}`;

  const working = rewards.filter((r) => r.brokenReason === null);
  const broken = rewards.filter((r) => r.brokenReason !== null);

  const embed = new EmbedBuilder().setTitle('Reward roles').addFields({
    name: 'Active',
    value:
      working.length === 0
        ? '*none*'
        : working
            .map((r) => `${describe(r)} → <@&${r.roleId}>`)
            .join('\n')
            .slice(0, 1024),
  });

  if (broken.length > 0) {
    // Kept rather than deleted: the admin may recreate a deleted role, and
    // silently discarding their configuration is hostile.
    embed.addFields({
      name: '⚠️ Not working',
      value: broken
        .map((r) => `${describe(r)} → <@&${r.roleId}> — ${explainBroken(r.brokenReason)}`)
        .join('\n')
        .slice(0, 1024),
    });
    embed.setFooter({ text: 'These rules are kept, but skipped until the problem is fixed.' });
  }

  await interaction.editReply({ embeds: [embed] });
}

function explainBroken(reason: string | null): string {
  switch (reason) {
    case 'role_deleted':
      return 'the role no longer exists';
    case 'hierarchy':
      return 'the role is above mine; move my role higher';
    case 'missing_permission':
      return 'I am missing Manage Roles';
    case 'managed':
      return 'the role belongs to an integration and cannot be assigned';
    case 'unassignable':
      return 'Discord does not allow this role to be granted to anyone';
    default:
      return 'unknown problem';
  }
}

// ---------------------------------------------------------------------------

function groupOf(setting: SettingDefinition): string {
  return setting.key.includes('.') ? (setting.key.split('.')[0] ?? 'general') : 'general';
}

function byGroup(settings: readonly SettingDefinition[]): Map<string, SettingDefinition[]> {
  const map = new Map<string, SettingDefinition[]>();
  for (const setting of settings) {
    const group = groupOf(setting);
    const list = map.get(group);
    if (list) list.push(setting);
    else map.set(group, [setting]);
  }
  return map;
}

/** A malformed stored value must not break the whole view. */
function safeRead(setting: SettingDefinition, config: GuildLevelingConfig): string {
  try {
    return setting.read(config);
  } catch {
    return '*unreadable*';
  }
}
