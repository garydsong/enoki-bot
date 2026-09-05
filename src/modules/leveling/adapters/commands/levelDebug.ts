import {
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
  type GuildTextBasedChannel,
} from 'discord.js';
import type { ModuleContext } from '../../../../platform/plugin/types.js';
import type { Database } from '../../../../platform/db/pool.js';
import { lastSuccesses } from '../../../../platform/jobs/scheduler.js';
import {
  dryRun,
  findConfigContradictions,
  findDanglingTargets,
  memberDebug,
  type HealthFinding,
} from '../../application/queries/debug.js';
import { computeRewardDiff } from '../../domain/rewards/resolver.js';
import { systemClock, systemRng } from '../../domain/support/clock.js';
import type { GuildLevelingConfig, LocationChain, TraceStep } from '../../domain/types.js';
import type { ConfigCache, RuleRepository } from '../../ports/config.js';
import { cooldownKey, type CooldownStore } from '../../ports/cooldowns.js';
import { whyUngrantable } from '../effects/rewardReconciler.js';
import { formatDuration, formatNumber } from './format.js';

/**
 * The `/level debug` subcommand group (roadmap M8).
 *
 * Every handler here answers a question an admin would otherwise answer by
 * reading source code or guessing, and each answer comes from the SAME code the
 * live path uses — the pipeline for `why`, the reward resolver for `rewards`,
 * the config assembler for `health`. A debug view built from a parallel
 * re-implementation is worse than none, because it is confidently wrong.
 */

export interface LevelDebugDeps {
  readonly db: Database;
  readonly configs: ConfigCache;
  readonly rules: RuleRepository;
  readonly cooldowns: CooldownStore;
  readonly requiredIntents: readonly string[];
  readonly version: string;
}

export async function handleDebug(
  interaction: ChatInputCommandInteraction,
  deps: LevelDebugDeps,
  ctx: ModuleContext,
  sub: string,
): Promise<void> {
  switch (sub) {
    case 'why':
      return debugWhy(interaction, deps);
    case 'member':
      return debugMember(interaction, deps);
    case 'rewards':
      return debugRewards(interaction, deps);
    case 'health':
      return debugHealth(interaction, deps, ctx);
    default:
      await interaction.editReply('Unknown debug subcommand.');
  }
}

// ---------------------------------------------------------------------------
// why
// ---------------------------------------------------------------------------

async function debugWhy(
  interaction: ChatInputCommandInteraction,
  deps: LevelDebugDeps,
): Promise<void> {
  const guildId = interaction.guildId as string;
  const target = interaction.options.getUser('user') ?? interaction.user;
  const channelOption = interaction.options.getChannel('channel');
  const config = await deps.configs.get(guildId);

  const member = await interaction.guild?.members.fetch(target.id).catch(() => null);
  if (!member) {
    await interaction.editReply(`${target.username} is not a member of this server.`);
    return;
  }

  const channel = (channelOption ?? interaction.channel) as GuildTextBasedChannel | null;
  if (!channel) {
    await interaction.editReply('Pick a channel to simulate a message in.');
    return;
  }

  const stored = await memberDebug(deps.db, guildId, target.id, config);

  const result = dryRun(
    {
      candidate: {
        source: 'message',
        occurredAt: Date.now(),
        // Prefixed so it can never collide with a real message id and be
        // mistaken for one in a log.
        idempotencyKey: `debug:${interaction.id}`,
        location: locationOf(channel),
        hasContent: true,
        messageLength: 50,
        wordCount: 10,
        whitespaceRuns: 9,
        attachmentCount: 0,
      },
      member: {
        userId: target.id,
        roleIds: [...member.roles.cache.keys()],
        isBot: target.bot,
        isWebhook: false,
        isSelf: false,
        isIgnored: false,
        ...(target.createdTimestamp ? { accountCreatedAt: target.createdTimestamp } : {}),
        ...(member.joinedTimestamp ? { joinedGuildAt: member.joinedTimestamp } : {}),
        currentTotalXp: stored?.totalXp ?? 0,
        currentLevel: stored?.level ?? 0,
        // PEEKED, never consumed. A debug command that burns the cooldown it is
        // reporting on changes the answer by asking the question.
        cooldownExpiresAt: deps.cooldowns.peek(cooldownKey(guildId, target.id, 'message')),
      },
      config,
    },
    systemClock,
    systemRng,
  );

  const embed = new EmbedBuilder()
    .setTitle(`Would ${member.displayName} earn message XP in #${channel.name}?`)
    .setDescription(
      result.decision.outcome === 'awarded'
        ? `**Yes** — about ${formatNumber(result.decision.finalXp)} XP ` +
            `(base ${formatNumber(result.decision.baseXp)}` +
            `${result.decision.effortBonus > 0 ? ` + ${result.decision.effortBonus} effort` : ''}` +
            `, ×${(result.decision.multiplierBps / 10000).toFixed(2)}).`
        : `**No.** ${result.failing.length} gate(s) said no:`,
    );

  if (result.failing.length > 0) {
    embed.addFields({
      name: 'Blocked by',
      // Collect-all mode: every failing gate, so fixing one does not simply
      // reveal the next on the following round trip.
      value: result.failing.map(renderStep).join('\n').slice(0, 1024),
    });
  }

  embed.addFields({
    name: 'Full trace',
    value: result.trace.map(renderStep).join('\n').slice(0, 1024),
  });

  embed.setFooter({
    text: 'Simulated with a 50-character, 10-word message. Nothing was awarded and no cooldown was used.',
  });

  await interaction.editReply({ embeds: [embed] });
}

function renderStep(step: TraceStep): string {
  const icon = step.verdict === 'pass' ? '✅' : step.verdict === 'deny' ? '❌' : '⏭️';
  return `${icon} \`${step.gate}\` — ${step.detail}`;
}

function locationOf(channel: GuildTextBasedChannel): LocationChain {
  const isThread = channel.isThread();
  const parent = isThread ? channel.parent : null;
  return {
    channelId: channel.id,
    parentChannelId: isThread ? (channel.parentId ?? null) : null,
    categoryId: isThread ? (parent?.parentId ?? null) : (channel.parentId ?? null),
    isThread,
    isForumPost: isThread && parent?.type === ChannelType.GuildForum,
    isVoiceText:
      channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice,
  };
}

// ---------------------------------------------------------------------------
// member
// ---------------------------------------------------------------------------

async function debugMember(
  interaction: ChatInputCommandInteraction,
  deps: LevelDebugDeps,
): Promise<void> {
  const guildId = interaction.guildId as string;
  const target = interaction.options.getUser('user') ?? interaction.user;
  const config = await deps.configs.get(guildId);

  const row = await memberDebug(deps.db, guildId, target.id, config);
  if (!row) {
    await interaction.editReply(`No stored record for ${target.username} in this server.`);
    return;
  }

  const cooldown = deps.cooldowns.peek(cooldownKey(guildId, target.id, 'message'));

  const embed = new EmbedBuilder()
    .setTitle(`Stored record — ${target.username}`)
    .addFields(
      {
        name: 'XP',
        value:
          `Total **${formatNumber(row.totalXp)}**\n` +
          `Level **${formatNumber(row.level)}** (${formatNumber(row.xpIntoLevel)}/${formatNumber(row.xpForNextLevel)})\n` +
          `Rank ${row.rank === null ? 'unranked' : `#${formatNumber(row.rank)}`}`,
        inline: true,
      },
      {
        name: 'This period',
        value: `Week **${formatNumber(row.weeklyXp)}**\nMonth **${formatNumber(row.monthlyXp)}**`,
        inline: true,
      },
      {
        name: 'Activity',
        value:
          `${formatNumber(row.messagesCounted)} counted messages\n` +
          `${formatDuration(row.voiceSeconds)} in voice\n` +
          `${formatNumber(row.reactionsReceived)} reactions received\n` +
          `${formatNumber(row.levelups)} level-ups`,
        inline: true,
      },
      {
        name: 'State',
        value:
          `Cooldown: ${cooldown === null ? 'ready' : `${Math.ceil((cooldown - Date.now()) / 1000)}s remaining`}\n` +
          `Last XP: ${row.lastXpAt ? `<t:${Math.floor(row.lastXpAt.getTime() / 1000)}:R>` : 'never'}\n` +
          `First seen: ${row.firstSeenAt ? `<t:${Math.floor(row.firstSeenAt.getTime() / 1000)}:D>` : 'unknown'}\n` +
          `${row.isDeparted ? '**Has left the server**' : 'In the server'}`,
        inline: true,
      },
    );

  await interaction.editReply({ embeds: [embed] });
}

// ---------------------------------------------------------------------------
// rewards
// ---------------------------------------------------------------------------

async function debugRewards(
  interaction: ChatInputCommandInteraction,
  deps: LevelDebugDeps,
): Promise<void> {
  const guildId = interaction.guildId as string;
  const target = interaction.options.getUser('user') ?? interaction.user;
  const config = await deps.configs.get(guildId);

  const member = await interaction.guild?.members.fetch(target.id).catch(() => null);
  const me = interaction.guild?.members.me;
  if (!member || !me || !interaction.guild) {
    await interaction.editReply('Could not read that member.');
    return;
  }

  const row = await memberDebug(deps.db, guildId, target.id, config);
  const level = row?.level ?? 0;

  const diff = computeRewardDiff(
    level,
    config.rewards,
    config.rewardStacking,
    [...member.roles.cache.keys()],
    { removeOnLevelDown: config.removeOnLevelDown },
  );

  // Exactly the check the reconciler runs, so the blockers reported here are
  // the blockers that will actually be hit.
  const blockers = diff.toAdd
    .map((roleId) => ({
      roleId,
      problem: whyUngrantable(interaction.guild?.roles.cache.get(roleId), me, guildId),
    }))
    .filter((entry) => entry.problem !== null);

  const stored = await deps.rules.listRewards(guildId);
  const broken = stored.filter((r) => r.brokenReason !== null);

  const embed = new EmbedBuilder()
    .setTitle(`Reward reconciliation — ${member.displayName} (level ${formatNumber(level)})`)
    .addFields(
      {
        name: 'Should hold',
        value: diff.desired.length === 0 ? '*none*' : diff.desired.map((r) => `<@&${r}>`).join(' '),
      },
      {
        name: 'Would add',
        value: diff.toAdd.length === 0 ? '*nothing*' : diff.toAdd.map((r) => `<@&${r}>`).join(' '),
      },
      {
        name: 'Would remove',
        value:
          diff.toRemove.length === 0
            ? '*nothing*'
            : diff.toRemove.map((r) => `<@&${r}>`).join(' '),
      },
    );

  if (blockers.length > 0) {
    embed.addFields({
      name: '⚠️ Cannot be granted',
      value: blockers
        .map((b) => `<@&${b.roleId}> — ${explain(b.problem ?? '')}`)
        .join('\n')
        .slice(0, 1024),
    });
  }

  if (broken.length > 0) {
    embed.addFields({
      name: '⚠️ Rules currently skipped',
      value: broken
        .map((r) => `Level ${r.level} → <@&${r.roleId}> — ${explain(r.brokenReason ?? '')}`)
        .join('\n')
        .slice(0, 1024),
    });
  }

  if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
    embed.addFields({
      name: '❌ Missing Manage Roles',
      value: 'No reward role can be granted until the bot has this permission.',
    });
  }

  await interaction.editReply({ embeds: [embed] });
}

function explain(reason: string): string {
  switch (reason) {
    case 'role_deleted':
      return 'the role no longer exists';
    case 'hierarchy':
      return 'the role is above mine — move my role higher in Server Settings → Roles';
    case 'missing_permission':
      return 'I am missing Manage Roles';
    case 'managed':
      return 'the role belongs to an integration and cannot be assigned';
    case 'unassignable':
      return 'Discord does not allow this role to be granted to anyone';
    default:
      return reason;
  }
}

// ---------------------------------------------------------------------------
// health
// ---------------------------------------------------------------------------

async function debugHealth(
  interaction: ChatInputCommandInteraction,
  deps: LevelDebugDeps,
  ctx: ModuleContext,
): Promise<void> {
  const guildId = interaction.guildId as string;
  const guild = interaction.guild;
  if (!guild) return;

  const config = await deps.configs.get(guildId);
  const findings: HealthFinding[] = [...findConfigContradictions(config)];

  findings.push(...permissionFindings(guild, config));

  const dangling = findDanglingTargets(config, {
    channel: (id) => guild.channels.cache.has(id),
    role: (id) => guild.roles.cache.has(id),
  });
  for (const entry of dangling) {
    findings.push({
      severity: 'error',
      title: 'Configuration points at something deleted',
      detail: `${entry.detail} (\`${entry.id}\`)`,
    });
  }

  const brokenRewards = (await deps.rules.listRewards(guildId)).filter(
    (r) => r.brokenReason !== null,
  );
  if (brokenRewards.length > 0) {
    findings.push({
      severity: 'error',
      title: `${brokenRewards.length} reward rule(s) are being skipped`,
      detail: brokenRewards
        .map((r) => `Level ${r.level} → <@&${r.roleId}> (${explain(r.brokenReason ?? '')})`)
        .join('\n'),
    });
  }

  // Database latency, measured rather than assumed.
  const started = Date.now();
  await deps.db.query('SELECT 1');
  const latencyMs = Date.now() - started;
  if (latencyMs > 250) {
    findings.push({
      severity: 'warn',
      title: 'The database is slow',
      detail: `A trivial query took ${latencyMs}ms.`,
    });
  }

  // A silently stopped job is the worst failure mode in this system: voice XP
  // simply ceases, with no error anywhere.
  const jobs = await lastSuccesses(deps.db);
  for (const job of jobs) {
    const age = job.finishedAt ? Date.now() - job.finishedAt.getTime() : null;
    if (age !== null && age > 6 * 3_600_000) {
      findings.push({
        severity: 'warn',
        title: `Job \`${job.jobName}\` has not succeeded recently`,
        detail: `Last success <t:${Math.floor((job.finishedAt?.getTime() ?? 0) / 1000)}:R>.`,
      });
    }
  }

  const errors = findings.filter((f) => f.severity === 'error');
  const warnings = findings.filter((f) => f.severity === 'warn');

  const embed = new EmbedBuilder()
    .setTitle(`Leveling health — ${guild.name}`)
    .setDescription(
      errors.length === 0 && warnings.length === 0
        ? '✅ Nothing to report. Everything checks out.'
        : `${errors.length} problem(s), ${warnings.length} thing(s) worth knowing.`,
    )
    .addFields({
      name: 'Runtime',
      value:
        `Version \`${deps.version}\`\n` +
        `Database ${latencyMs}ms\n` +
        `Intents: ${deps.requiredIntents.join(', ')}\n` +
        `Jobs: ${jobs.length === 0 ? 'none have run yet' : jobs.map((j) => j.jobName).join(', ')}`,
    });

  for (const finding of [...errors, ...warnings].slice(0, 20)) {
    embed.addFields({
      name: `${finding.severity === 'error' ? '❌' : '⚠️'} ${finding.title}`,
      value: finding.detail.slice(0, 1024),
    });
  }

  ctx.log.debug({ guildId, errors: errors.length, warnings: warnings.length }, 'health report');
  await interaction.editReply({ embeds: [embed] });
}

/**
 * Permission problems the bot cannot fix and will otherwise fail on silently.
 * Checked per configured channel rather than guild-wide, because Discord
 * permissions are per-channel and a guild-wide check would miss the common case.
 */
function permissionFindings(guild: Guild, config: GuildLevelingConfig): HealthFinding[] {
  const findings: HealthFinding[] = [];
  const me: GuildMember | null = guild.members.me;
  if (!me) return findings;

  if (config.rewards.length > 0 && !me.permissions.has(PermissionFlagsBits.ManageRoles)) {
    findings.push({
      severity: 'error',
      title: 'Missing Manage Roles',
      detail: 'Reward roles are configured but none can be granted.',
    });
  }

  if (config.notifications.mode === 'fixed_channel' && config.notifications.channelId) {
    const channel = guild.channels.cache.get(config.notifications.channelId);
    if (channel?.isTextBased()) {
      const permissions = channel.permissionsFor(me);
      if (!permissions?.has(PermissionFlagsBits.ViewChannel)) {
        findings.push({
          severity: 'error',
          title: 'Cannot see the level-up channel',
          detail: `I lack View Channel in <#${channel.id}>, so nothing is announced.`,
        });
      } else if (!permissions.has(PermissionFlagsBits.SendMessages)) {
        findings.push({
          severity: 'error',
          title: 'Cannot post in the level-up channel',
          detail: `I lack Send Messages in <#${channel.id}>.`,
        });
      }
    }
  }

  return findings;
}
