import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type MessageComponentInteraction,
} from 'discord.js';
import type { ComponentHandler, ModuleContext } from '../../../../platform/plugin/types.js';
import type { AuditRepository } from '../../ports/config.js';
import type { BackfillProgress, RewardBackfill } from '../../application/rewardBackfill.js';
import { formatNumber } from './format.js';

/**
 * `/level reward backfill` — the Discord half (roadmap M15).
 *
 * Everything that decides WHAT happens lives in
 * `application/rewardBackfill.ts`; this file is the parts that only make sense
 * in front of a person:
 *
 * - the reply is edited as the run progresses, because a mass role operation
 *   over a large guild takes minutes and a spinner that never changes is
 *   indistinguishable from a hang;
 * - the Cancel button, whose press writes a status the run itself reads;
 * - and the deliberate framing of a dry run as a report with a nudge, since
 *   the whole safety story is that an admin looks before applying.
 */

export const BACKFILL_PREFIX = 'rwbf';

export interface BackfillCommandDeps {
  readonly backfill: RewardBackfill;
  readonly audit: AuditRepository;
}

export async function handleBackfill(
  interaction: ChatInputCommandInteraction,
  deps: BackfillCommandDeps,
  ctx: ModuleContext,
): Promise<void> {
  const guildId = interaction.guildId as string;
  const apply = interaction.options.getBoolean('apply') ?? false;
  const includeDeparted = interaction.options.getBoolean('include-departed') ?? false;

  const cancelRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${BACKFILL_PREFIX}:cancel:${guildId}:${interaction.user.id}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Danger),
  );

  await interaction.editReply({
    embeds: [running(apply, null)],
    // A dry run is fast and makes no changes; offering to cancel it is noise.
    components: apply ? [cancelRow] : [],
  });

  const outcome = await deps.backfill.run({
    guildId,
    actorId: interaction.user.id,
    apply,
    includeDeparted,
    onProgress: async (progress) => {
      await interaction.editReply({
        embeds: [running(apply, progress)],
        components: apply && !progress.done ? [cancelRow] : [],
      });
    },
  });

  if (outcome.status === 'no_rules') {
    await interaction.editReply({
      content:
        'There are no reward roles configured, so there is nothing to backfill. ' +
        'Add one with `/level reward add level:10 role:@Regular`.',
      embeds: [],
      components: [],
    });
    return;
  }

  if (outcome.status === 'already_running') {
    await interaction.editReply({
      content:
        'A backfill is already running in this server' +
        (outcome.startedAt ? `, started <t:${Math.floor(outcome.startedAt.getTime() / 1000)}:R>` : '') +
        '. Wait for it to finish, or cancel it from its own message.',
      embeds: [],
      components: [],
    });
    return;
  }

  if (apply) {
    await deps.audit.record(guildId, {
      actorId: interaction.user.id,
      action: 'reward.backfill',
      after: {
        scanned: outcome.progress.scanned,
        changed: outcome.progress.changed,
        rolesAdded: outcome.progress.rolesAdded,
        rolesRemoved: outcome.progress.rolesRemoved,
        cancelled: outcome.status === 'cancelled',
      },
    });
  }

  ctx.log.info(
    { guildId, apply, status: outcome.status, ...outcome.progress },
    'reward backfill command finished',
  );

  await interaction.editReply({
    embeds: [finished(apply, outcome.status === 'cancelled', outcome.progress)],
    components: [],
  });
}

function running(apply: boolean, progress: BackfillProgress | null): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(apply ? 'Backfilling reward roles…' : 'Checking reward roles…')
    .setDescription(
      progress === null
        ? 'Starting.'
        : `${formatNumber(progress.scanned)} members checked · ` +
          `${formatNumber(progress.changed)} ${apply ? 'changed' : 'would change'}`,
    );
}

function finished(apply: boolean, cancelled: boolean, p: BackfillProgress): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(
      cancelled
        ? 'Backfill stopped'
        : apply
          ? 'Backfill complete'
          : 'Backfill preview (nothing was changed)',
    )
    .addFields(
      { name: 'Members checked', value: formatNumber(p.scanned), inline: true },
      {
        name: apply ? 'Members changed' : 'Would change',
        value: formatNumber(p.changed),
        inline: true,
      },
      {
        name: apply ? 'Roles added / removed' : 'Roles to add / remove',
        value: `${formatNumber(p.rolesAdded)} / ${formatNumber(p.rolesRemoved)}`,
        inline: true,
      },
    );

  if (p.broken > 0) {
    embed.addFields({
      name: '⚠️ Unusable roles',
      value:
        `${formatNumber(p.broken)} reward role(s) could not be granted. ` +
        'Run `/level reward list` to see why.',
    });
  }

  if (!apply && !cancelled) {
    embed.setFooter({
      // The nudge is the point of defaulting to a dry run: an admin who has
      // seen these numbers is making a decision rather than discovering one.
      text: 'Nothing was changed. Run it again with apply:True to make it real.',
    });
  }
  if (cancelled) {
    embed.setFooter({
      text: 'Stopped part-way. Reconciliation is idempotent, so running it again resumes safely.',
    });
  }

  return embed;
}

/**
 * The Cancel button.
 *
 * It writes a status to the claim row rather than setting a flag in this
 * process, so it stops the run even if a different process is executing it —
 * and so a run that outlives the interaction token can still be stopped.
 */
export function createBackfillComponent(deps: {
  readonly backfill: RewardBackfill;
}): ComponentHandler {
  return {
    customIdPrefix: BACKFILL_PREFIX,
    async handle(interaction: MessageComponentInteraction) {
      const [, , guildId, ownerId] = interaction.customId.split(':');

      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        await interaction.reply({
          content: 'You need the **Manage Server** permission to stop a backfill.',
          ephemeral: true,
        });
        return;
      }

      const stopped = await deps.backfill.cancel(guildId ?? interaction.guildId ?? '');
      await interaction.reply({
        content: stopped
          ? 'Stopping — the run will finish the member it is on and then stop.'
          : 'That backfill has already finished.',
        ephemeral: true,
      });
      void ownerId;
    },
  };
}
