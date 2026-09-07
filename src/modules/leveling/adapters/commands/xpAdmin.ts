import {
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { CommandDefinition, ModuleContext } from '../../../../platform/plugin/types.js';
import type { XpAwarder } from '../../application/awardXp.js';
import type { ImportMode, ImportPlan, XpImporter } from '../../application/xpImport.js';
import { getCurve } from '../../domain/curve/curve.js';
import type { XpImportError } from '../../domain/import/csv.js';
import { validateDiscordCdnUrl } from '../../domain/net/discordCdn.js';
import type {
  AuditEntry,
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
  readonly importer: XpImporter;
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

      const sub = interaction.options.getSubcommand();

      // `/xp forget` is the ONE subcommand a member may run without Manage
      // Server, because MR-7 is a member's right to have their own data
      // deleted — a right that an admin has to approve is not one. The handler
      // re-checks: without Manage Server you may only name yourself.
      if (sub !== 'forget' && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        await interaction.editReply('You need the **Manage Server** permission to adjust XP.');
        return;
      }

      switch (sub) {
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
        case 'import':
          return importXp(interaction, deps, ctx);
        case 'forget':
          return forgetMember(interaction, deps, ctx);
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
      sub
        .setName('import')
        .setDescription('Import XP from a CSV file (from Arcane, MEE6, a spreadsheet…)')
        .addAttachmentOption((o) =>
          o
            .setName('file')
            .setDescription('A CSV with a user id column and an XP column')
            .setRequired(true),
        )
        .addStringOption((o) =>
          o
            .setName('mode')
            .setDescription('Replace each member’s total, or add to it')
            .addChoices(
              { name: 'set — replace their total (default)', value: 'set' },
              { name: 'add — add to their existing total', value: 'add' },
            ),
        )
        .addBooleanOption((o) =>
          o
            .setName('apply')
            .setDescription('Actually import (default: show what would happen)'),
        )
        .addBooleanOption((o) =>
          o
            .setName('skip-invalid')
            .setDescription('Import the good rows and ignore the bad ones'),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('forget')
        .setDescription('Permanently delete a member’s leveling data')
        .addUserOption((o) =>
          o.setName('user').setDescription('Who (members may only name themselves)'),
        )
        .addBooleanOption((o) =>
          o.setName('confirm').setDescription('This cannot be undone').setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('audit')
        .setDescription('Show recent administrative changes')
        .addUserOption((o) => o.setName('user').setDescription('Only entries about this member'))
        .addUserOption((o) => o.setName('actor').setDescription('Only entries by this admin'))
        .addStringOption((o) =>
          o
            .setName('action')
            .setDescription('Exact action, or a prefix like `xp.` or `reward.`')
            .setMaxLength(40),
        )
        .addIntegerOption((o) =>
          o
            .setName('limit')
            .setDescription('How many entries (default 15, max 50)')
            .setMinValue(1)
            .setMaxValue(50),
        ),
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

/**
 * `/xp import` — bring a server's history over from another bot (roadmap M15).
 *
 * The command's job is entirely about the moment BEFORE the write: fetch the
 * file safely, hand it to the importer, and show the admin what it would do.
 * The default is a preview, and the preview is generated by the same parse and
 * the same diff that the real import uses.
 */
async function importXp(
  interaction: ChatInputCommandInteraction,
  deps: XpAdminDeps,
  ctx: ModuleContext,
): Promise<void> {
  const guildId = interaction.guildId as string;
  const attachment = interaction.options.getAttachment('file', true);
  const mode = (interaction.options.getString('mode') ?? 'set') as ImportMode;
  const apply = interaction.options.getBoolean('apply') ?? false;
  const skipInvalid = interaction.options.getBoolean('skip-invalid') ?? false;

  if (attachment.size > MAX_IMPORT_BYTES) {
    await interaction.editReply(
      `That file is ${formatBytes(attachment.size)}; the limit is ` +
        `${formatBytes(MAX_IMPORT_BYTES)}. Split it and import the parts.`,
    );
    return;
  }

  const text = await fetchAttachment(attachment.url);
  if (text === null) {
    await interaction.editReply(
      'I could not read that file. Attachments have to be uploaded to Discord ' +
        '(which the `file` option does for you) — a pasted link to somewhere else is refused.',
    );
    return;
  }

  const config = await deps.configs.get(guildId);
  const plan = await deps.importer.plan(guildId, text, mode, config);

  if (plan.rows.length === 0) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle('Nothing to import')
          .setDescription(
            'No usable rows were found. The file needs a Discord **user id** column and an ' +
              '**XP** column — either named (`user_id,xp`) or as the first two columns.',
          )
          .addFields(errorField(plan.errors)),
      ],
    });
    return;
  }

  if (plan.errors.length > 0 && !skipInvalid) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle('Import refused — the file has problems')
          .setDescription(
            `${formatNumber(plan.rows.length)} rows are fine and ` +
              `${formatNumber(plan.errors.length)} are not.\n\n` +
              'Nothing was imported. Fix the file, or re-run with `skip-invalid: True` to ' +
              'import the good rows only.\n\n' +
              '*A bad row is usually a sign the wrong column was read — check the first ' +
              'few before skipping them.*',
          )
          .addFields(errorField(plan.errors)),
      ],
    });
    return;
  }

  if (!apply) {
    await interaction.editReply({
      embeds: [planEmbed(plan, mode, config.curve.maxLevel).setFooter({
        text: 'Nothing was changed. Run it again with apply:True to import.',
      })],
    });
    return;
  }

  const result = await deps.importer.apply(guildId, plan.rows, mode, config);

  await deps.audit.record(guildId, {
    actorId: interaction.user.id,
    action: 'xp.import',
    after: {
      mode,
      rows: plan.rows.length,
      applied: result.applied,
      skipped: plan.errors.length,
      failedAtBatch: result.failedAtBatch,
    },
  });

  ctx.log.warn(
    { guildId, actor: interaction.user.id, mode, applied: result.applied },
    'xp import performed',
  );

  const embed = planEmbed(plan, mode, config.curve.maxLevel).setTitle(
    result.failedAtBatch === null ? 'Import complete' : 'Import stopped part-way',
  );

  if (result.failedAtBatch !== null) {
    embed.addFields({
      name: '❌ Stopped',
      value:
        `${formatNumber(result.applied)} of ${formatNumber(plan.rows.length)} rows were ` +
        `committed before batch ${result.failedAtBatch} failed:\n\`${result.error ?? 'unknown'}\`\n` +
        'Each batch is its own transaction, so the failed one changed nothing. ' +
        'Re-running in `set` mode is safe — it is idempotent.',
    });
  } else {
    embed.setFooter({
      text:
        'Reward roles are not granted automatically — run `/level reward backfill` next.',
    });
  }

  await interaction.editReply({ embeds: [embed] });
}

/** 5 MB. About 200,000 rows, which is more members than Discord allows. */
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

/**
 * Read the attachment.
 *
 * The URL is re-validated against the CDN allowlist even though it came from
 * Discord's own attachment object, for the same reason the card renderer does:
 * this is the last gate before the process makes an outbound request, and a
 * gate that trusts its caller is not a gate. `redirect: 'error'` closes the
 * other half — an allowed host must not be able to bounce us elsewhere.
 */
async function fetchAttachment(url: string): Promise<string | null> {
  const validated = validateDiscordCdnUrl(url);
  if (!validated.ok) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(validated.url, {
      signal: controller.signal,
      redirect: 'error',
    });
    if (!response.ok) return null;

    const buffer = Buffer.from(await response.arrayBuffer());
    // Checked again after the fact: the attachment's declared size is a claim.
    if (buffer.byteLength > MAX_IMPORT_BYTES) return null;
    return buffer.toString('utf8');
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function planEmbed(plan: ImportPlan, mode: ImportMode, maxLevel: number | null): EmbedBuilder {
  const delta = plan.resultingXp - plan.currentXp;
  const embed = new EmbedBuilder()
    .setTitle('Import preview')
    .setDescription(
      mode === 'set'
        ? '**set** — each member’s total is REPLACED by the value in the file.'
        : '**add** — the value in the file is ADDED to what they already have.',
    )
    .addFields(
      { name: 'Rows', value: formatNumber(plan.rows.length), inline: true },
      { name: 'Already here', value: formatNumber(plan.existing), inline: true },
      { name: 'New members', value: formatNumber(plan.fresh), inline: true },
      {
        name: 'XP for these members',
        value:
          `${formatNumber(plan.currentXp)} → ${formatNumber(plan.resultingXp)} ` +
          `(${delta >= 0 ? '+' : ''}${formatNumber(delta)})`,
      },
      {
        name: 'Highest level reached',
        value:
          formatNumber(plan.topLevel) +
          (maxLevel !== null && plan.topLevel >= maxLevel ? ` (capped at ${maxLevel})` : ''),
      },
    );

  if (plan.errors.length > 0) {
    embed.addFields(errorField(plan.errors));
  }
  if (mode === 'set' && plan.existing > 0) {
    embed.addFields({
      name: '⚠️ Overwrites',
      value:
        `${formatNumber(plan.existing)} of these members already have XP here, and ` +
        '`set` mode replaces it. Use `mode: add` if you meant to combine the two.',
    });
  }
  return embed;
}

function errorField(errors: readonly XpImportError[]): { name: string; value: string } {
  if (errors.length === 0) return { name: 'Problems', value: '*none*' };
  const shown = errors.slice(0, 8);
  return {
    name: `Problems (${formatNumber(errors.length)})`,
    value:
      shown
        .map((e) => `Line ${e.line}: ${e.reason}`)
        .join('\n')
        .slice(0, 950) + (errors.length > shown.length ? `\n…and ${errors.length - shown.length} more` : ''),
  };
}

function formatBytes(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${Math.round(bytes / 1024)} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * `/xp forget` — a member's right to erasure (MR-7, roadmap M15).
 *
 * Distinct from `/xp reset`, and the distinction is the whole feature: reset
 * zeroes the score and keeps the record, this deletes the record. It is also
 * the one `/xp` subcommand a member may run on themselves without Manage
 * Server — a deletion right that requires an admin's cooperation is not a
 * right — while naming SOMEONE ELSE still requires the permission.
 *
 * `disableResets` deliberately does NOT block it. That setting exists to stop
 * an admin wiping the server's scores by accident; using it to prevent a member
 * deleting their own data would be a different thing wearing its name.
 */
async function forgetMember(
  interaction: ChatInputCommandInteraction,
  deps: XpAdminDeps,
  ctx: ModuleContext,
): Promise<void> {
  const guildId = interaction.guildId as string;
  const target = interaction.options.getUser('user') ?? interaction.user;
  const isSelf = target.id === interaction.user.id;

  if (!isSelf && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.editReply(
      'You can delete your own leveling data, but deleting someone else’s needs the ' +
        '**Manage Server** permission.',
    );
    return;
  }

  if (!interaction.options.getBoolean('confirm', true)) {
    await interaction.editReply(
      'Nothing was deleted. Re-run with `confirm: True`.\n' +
        'This removes XP, level, statistics, weekly and monthly history and rank card ' +
        'settings — permanently, with no undo.',
    );
    return;
  }

  const result = await deps.memberXp.forget(guildId, target.id);

  if (result.xpRows === 0 && result.statRows === 0 && result.cardRows === 0) {
    await interaction.editReply(
      isSelf
        ? 'There was nothing stored about you in this server.'
        : `Nothing is stored about ${target.username} in this server.`,
    );
    return;
  }

  // Recorded because a deletion is exactly the kind of change an admin later
  // needs to explain. The entry names the member and the totals — not their
  // content, which was never stored (spec `06` §2.12).
  await deps.audit.record(guildId, {
    actorId: interaction.user.id,
    action: isSelf ? 'xp.forget_self' : 'xp.forget',
    targetUserId: target.id,
    before: { totalXp: result.totalXpErased },
    after: { deleted: true },
  });

  ctx.log.warn(
    { guildId, actor: interaction.user.id, target: target.id, ...result },
    'member leveling data erased',
  );

  await interaction.editReply(
    `Deleted${isSelf ? ' your' : ` ${target.username}'s`} leveling data in this server: ` +
      `${formatNumber(result.totalXpErased)} XP, ${formatNumber(result.periodRows)} period ` +
      `record(s), ${formatNumber(result.statRows)} statistics row(s) and ` +
      `${formatNumber(result.cardRows)} card setting(s).\n` +
      'Reward roles are not removed — ask an admin if you want those taken off too. ' +
      'Earning XP again from here starts from zero.',
  );
}

async function showAudit(
  interaction: ChatInputCommandInteraction,
  deps: XpAdminDeps,
): Promise<void> {
  const target = interaction.options.getUser('user');
  const actor = interaction.options.getUser('actor');
  const action = interaction.options.getString('action');
  const limit = interaction.options.getInteger('limit') ?? 15;

  const entries = await deps.audit.search(interaction.guildId as string, {
    targetUserId: target?.id ?? null,
    actorId: actor?.id ?? null,
    action,
    limit,
  });

  const filtered = Boolean(target ?? actor ?? action);

  if (entries.length === 0) {
    await interaction.editReply(
      filtered
        ? 'No administrative changes match those filters.'
        : 'No administrative changes have been recorded yet.',
    );
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle(filtered ? 'Administrative changes (filtered)' : 'Recent administrative changes')
    .setDescription(
      entries
        .map((entry) => {
          const when = entry.createdAt
            ? `<t:${Math.floor(entry.createdAt.getTime() / 1000)}:R> `
            : '';
          const by = entry.actorId ? `<@${entry.actorId}>` : 'system';
          const on = entry.targetUserId ? ` → <@${entry.targetUserId}>` : '';
          const reason = entry.reason ? ` *(${entry.reason})*` : '';
          return `${when}\`${entry.action}\` by ${by}${on}${reason}${describeChange(entry)}`;
        })
        .join('\n')
        .slice(0, 4000),
    );

  if (filtered) {
    embed.setFooter({
      text: [
        target ? `about ${target.username}` : null,
        actor ? `by ${actor.username}` : null,
        action ? `action ${action}` : null,
      ]
        .filter(Boolean)
        .join(' · '),
    });
  }

  await interaction.editReply({ embeds: [embed] });
}

/**
 * " 400 → 900 XP" when both sides are known.
 *
 * The audit log stores arbitrary JSON, so this reads defensively and shows
 * nothing rather than guessing — a malformed entry from an older version must
 * not break the whole listing.
 */
function describeChange(entry: AuditEntry): string {
  const xpOf = (value: unknown): number | null => {
    if (typeof value !== 'object' || value === null) return null;
    const raw = (value as { totalXp?: unknown }).totalXp;
    return typeof raw === 'number' ? raw : null;
  };

  const before = xpOf(entry.before);
  const after = xpOf(entry.after);
  if (before === null || after === null || before === after) return '';
  return ` — ${formatNumber(before)} → ${formatNumber(after)} XP`;
}
