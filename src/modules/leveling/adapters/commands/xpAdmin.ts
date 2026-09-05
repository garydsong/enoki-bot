import {
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { CommandDefinition, ModuleContext } from '../../../../platform/plugin/types.js';
import type { XpAwarder } from '../../application/awardXp.js';
import { getCurve } from '../../domain/curve/curve.js';
import type {
  AuditRepository,
  ConfigCache,
  ConfigRepository,
} from '../../ports/config.js';
import type { MemberXpRepository } from '../../ports/memberXp.js';
import { formatNumber } from './format.js';

/**
 * `/xp` — manual XP administration (US-17, US-18, spec `03` §4.4).
 *
 * The design pressure here is entirely about DESTRUCTION and TRUST:
 *
 * - Every mutation is written to the audit log with the actor, before and
 *   after. An admin with Manage Server can already do worse things than inflate
 *   a friend's level, so the answer is transparency rather than prevention
 *   (spec `08` §2).
 * - Resets require an explicit confirmation and can be disabled entirely for a
 *   server that never wants to risk it (`admin.disableResets`).
 * - Manual grants go through the SAME award path as earned XP, so a level-up
 *   from `/xp add` announces and grants roles exactly like a normal one — with
 *   an opt-out for a quiet correction.
 */

export interface XpAdminDeps {
  readonly awarder: XpAwarder;
  readonly memberXp: MemberXpRepository;
  readonly config: ConfigRepository;
  readonly configs: ConfigCache;
  readonly audit: AuditRepository;
}

export function createXpCommand(deps: XpAdminDeps): CommandDefinition {
  return {
    name: 'xp',
    defer: true,
    ephemeral: true,
    data: buildData(),

    async execute(interaction: ChatInputCommandInteraction, ctx) {
      if (!interaction.guildId || !interaction.inGuild()) {
        await interaction.editReply('This command only works inside a server.');
        return;
      }
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        await interaction.editReply('You need the **Manage Server** permission to adjust XP.');
        return;
      }

      switch (interaction.options.getSubcommand()) {
        case 'add':
          return adjust(interaction, deps, ctx, 1);
        case 'remove':
          return adjust(interaction, deps, ctx, -1);
        case 'set':
          return setXp(interaction, deps, ctx);
        case 'reset':
          return resetMember(interaction, deps, ctx);
        case 'reset-server':
          return resetGuild(interaction, deps, ctx);
        case 'audit':
          return showAudit(interaction, deps);
        default:
          await interaction.editReply('Unknown subcommand.');
      }
    },
  };
}

function buildData() {
  const amount = (name: string, description: string) => ({ name, description });
  void amount;

  return new SlashCommandBuilder()
    .setName('xp')
    .setDescription('Adjust member XP')
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)

    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('Give a member XP')
        .addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true))
        .addIntegerOption((o) =>
          o.setName('amount').setDescription('How much XP').setRequired(true).setMinValue(1),
        )
        .addStringOption((o) =>
          o.setName('reason').setDescription('Recorded in the audit log').setMaxLength(200),
        )
        .addBooleanOption((o) =>
          o.setName('silent').setDescription('Do not announce a resulting level-up'),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('Take XP away from a member')
        .addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true))
        .addIntegerOption((o) =>
          o.setName('amount').setDescription('How much XP').setRequired(true).setMinValue(1),
        )
        .addStringOption((o) =>
          o.setName('reason').setDescription('Recorded in the audit log').setMaxLength(200),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('set')
        .setDescription('Set a member’s total XP to an exact number')
        .addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true))
        .addIntegerOption((o) =>
          o.setName('amount').setDescription('New total XP').setRequired(true).setMinValue(0),
        )
        .addStringOption((o) =>
          o.setName('reason').setDescription('Recorded in the audit log').setMaxLength(200),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('reset')
        .setDescription('Wipe one member’s XP')
        .addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true))
        .addBooleanOption((o) =>
          o
            .setName('confirm')
            .setDescription('This cannot be undone')
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('reset-server')
        .setDescription('Wipe EVERY member’s XP in this server')
        .addStringOption((o) =>
          o
            .setName('confirm')
            .setDescription('Type the server name exactly to confirm')
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName('audit').setDescription('Show recent administrative changes'),
    )
    .toJSON();
}

// ---------------------------------------------------------------------------

async function adjust(
  interaction: ChatInputCommandInteraction,
  deps: XpAdminDeps,
  ctx: ModuleContext,
  sign: 1 | -1,
): Promise<void> {
  const guildId = interaction.guildId as string;
  const target = interaction.options.getUser('user', true);
  const requested = interaction.options.getInteger('amount', true);
  const reason = interaction.options.getString('reason');
  const silent = interaction.options.getBoolean('silent') ?? sign === -1;

  if (target.bot) {
    await interaction.editReply('Bots do not have XP.');
    return;
  }

  const config = await deps.configs.get(guildId);

  // A cap on a SINGLE grant, not a total. It exists to catch a fat-fingered
  // extra zero, not to constrain a determined admin.
  if (requested > config.manualGrantMax) {
    await interaction.editReply(
      `That is more than this server's single-grant limit of ` +
        `${formatNumber(config.manualGrantMax)} XP.\n` +
        'Raise it with `/level config set admin.manualGrantMax <number>` if that is intended.',
    );
    return;
  }

  const event = await deps.awarder.awardManual({
    guildId,
    userId: target.id,
    delta: sign * requested,
    config,
    silent,
  });

  await deps.audit.record(guildId, {
    actorId: interaction.user.id,
    action: sign === 1 ? 'xp.add' : 'xp.remove',
    targetUserId: target.id,
    before: { totalXp: event.totalXpBefore, level: event.levelBefore },
    after: { totalXp: event.totalXpAfter, level: event.levelAfter },
    reason,
  });

  ctx.log.info(
    { guildId, actor: interaction.user.id, target: target.id, delta: sign * requested },
    'manual xp adjustment',
  );

  const clamped = Math.abs(event.xpAwarded) < requested && sign === -1;

  await interaction.editReply(
    `${target.username}: ${formatNumber(event.totalXpBefore)} → ` +
      `**${formatNumber(event.totalXpAfter)}** XP ` +
      `(level ${event.levelBefore} → ${event.levelAfter}).` +
      (clamped ? '\nXP cannot go below zero, so it stopped at 0.' : '') +
      (event.leveledUp && silent ? '\nThey levelled up; the announcement was suppressed.' : ''),
  );
}

async function setXp(
  interaction: ChatInputCommandInteraction,
  deps: XpAdminDeps,
  ctx: ModuleContext,
): Promise<void> {
  const guildId = interaction.guildId as string;
  const target = interaction.options.getUser('user', true);
  const total = interaction.options.getInteger('amount', true);
  const reason = interaction.options.getString('reason');

  if (target.bot) {
    await interaction.editReply('Bots do not have XP.');
    return;
  }

  const config = await deps.configs.get(guildId);
  const level = getCurve(config.curve).levelFromTotalXp(total);

  const event = await deps.awarder.awardManual({
    guildId,
    userId: target.id,
    delta: 0,
    setAbsolute: total,
    config,
    // A correction is not an achievement. Setting an exact total is almost
    // always fixing something, so it never announces.
    silent: true,
  });

  await deps.audit.record(guildId, {
    actorId: interaction.user.id,
    action: 'xp.set',
    targetUserId: target.id,
    before: { totalXp: event.totalXpBefore, level: event.levelBefore },
    after: { totalXp: event.totalXpAfter, level: event.levelAfter },
    reason,
  });

  ctx.log.info(
    { guildId, actor: interaction.user.id, target: target.id, total },
    'manual xp set',
  );

  await interaction.editReply(
    `${target.username} is now at **${formatNumber(total)}** XP (level ${level}), ` +
      `from ${formatNumber(event.totalXpBefore)} (level ${event.levelBefore}).`,
  );
}

async function resetMember(
  interaction: ChatInputCommandInteraction,
  deps: XpAdminDeps,
  ctx: ModuleContext,
): Promise<void> {
  const guildId = interaction.guildId as string;
  const target = interaction.options.getUser('user', true);
  const config = await deps.configs.get(guildId);

  if (config.disableResets) {
    await interaction.editReply(
      'Resets are disabled in this server (`admin.disableResets`). ' +
        'Turn it off first if this is really intended.',
    );
    return;
  }
  if (!interaction.options.getBoolean('confirm', true)) {
    await interaction.editReply('Nothing changed. Re-run with `confirm: True` to wipe their XP.');
    return;
  }

  const before = await deps.memberXp.get(guildId, target.id);
  await deps.memberXp.reset(guildId, target.id);

  await deps.audit.record(guildId, {
    actorId: interaction.user.id,
    action: 'xp.reset',
    targetUserId: target.id,
    before: { totalXp: before?.totalXp ?? 0, level: before?.level ?? 0 },
    after: { totalXp: 0, level: 0 },
  });

  ctx.log.warn({ guildId, actor: interaction.user.id, target: target.id }, 'member xp reset');

  await interaction.editReply(
    `${target.username}'s XP is back to zero (was ${formatNumber(before?.totalXp ?? 0)}).\n` +
      'Their message and voice statistics were kept; reward roles are not removed automatically.',
  );
}

async function resetGuild(
  interaction: ChatInputCommandInteraction,
  deps: XpAdminDeps,
  ctx: ModuleContext,
): Promise<void> {
  const guildId = interaction.guildId as string;
  const config = await deps.configs.get(guildId);

  if (config.disableResets) {
    await interaction.editReply('Resets are disabled in this server (`admin.disableResets`).');
    return;
  }

  // Typing the server name, not a boolean: this is the single most destructive
  // action the bot can take, and a checkbox is too easy to click by reflex.
  const typed = interaction.options.getString('confirm', true).trim();
  const name = interaction.guild?.name ?? '';
  if (typed !== name) {
    await interaction.editReply(
      `Nothing changed. To wipe every member's XP, run this again and type the server name ` +
        `exactly: \`${name}\``,
    );
    return;
  }

  const affected = await deps.memberXp.resetGuild(guildId);

  await deps.audit.record(guildId, {
    actorId: interaction.user.id,
    action: 'xp.reset_server',
    after: { membersAffected: affected },
  });

  ctx.log.warn(
    { guildId, actor: interaction.user.id, affected },
    'GUILD-WIDE xp reset performed',
  );

  await interaction.editReply(
    `Wiped XP for **${formatNumber(affected)}** members.\n` +
      'Statistics and configuration were kept. Reward roles are not removed automatically — ' +
      'members keep them until their roles are next reconciled.',
  );
}

async function showAudit(
  interaction: ChatInputCommandInteraction,
  deps: XpAdminDeps,
): Promise<void> {
  const entries = await deps.audit.recent(interaction.guildId as string, 15);

  if (entries.length === 0) {
    await interaction.editReply('No administrative changes have been recorded yet.');
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle('Recent administrative changes')
    .setDescription(
      entries
        .map((entry) => {
          const actor = entry.actorId ? `<@${entry.actorId}>` : 'system';
          const target = entry.targetUserId ? ` → <@${entry.targetUserId}>` : '';
          const reason = entry.reason ? ` *(${entry.reason})*` : '';
          return `\`${entry.action}\` by ${actor}${target}${reason}`;
        })
        .join('\n')
        .slice(0, 4000),
    );

  await interaction.editReply({ embeds: [embed] });
}
