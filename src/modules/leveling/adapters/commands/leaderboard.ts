import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type {
  CommandDefinition,
  ComponentHandler,
  ModuleContext,
} from '../../../../platform/plugin/types.js';
import {
  metricLabel,
  type LeaderboardMetric,
  type LeaderboardPage,
  type LeaderboardService,
} from '../../application/queries/leaderboard.js';
import type { ConfigCache } from '../../ports/config.js';
import type { GuildLevelingConfig } from '../../domain/types.js';
import { escapeMarkdown, formatDuration, formatNumber, rankBadge } from './format.js';

/**
 * `/leaderboard` with pagination (US-06, US-07).
 *
 * THE CUSTOM ID CARRIES ALL THE STATE. `lb:page:xp:3:1234` is "page 3 of the XP
 * board, opened by 1234" — there is no server-side session, so the buttons on a
 * three-day-old message still work after a restart, and a busy bot holds no
 * per-message memory.
 *
 * A button pressed by SOMEONE ELSE answers them ephemerally instead of editing
 * the shared message. Two people paging the same board would otherwise yank it
 * out from under each other.
 */

const PREFIX = 'lb';

const METRIC_CHOICES: readonly { name: string; value: LeaderboardMetric }[] = [
  { name: 'Total XP', value: 'xp' },
  { name: 'Level', value: 'level' },
  { name: 'XP this week', value: 'weekly' },
  { name: 'XP this month', value: 'monthly' },
  { name: 'Voice time', value: 'voice' },
  { name: 'Messages', value: 'messages' },
  { name: 'Reactions received', value: 'reactions' },
];

export interface LeaderboardCommandDeps {
  readonly boards: LeaderboardService;
  readonly configs: ConfigCache;
}

export function createLeaderboardCommand(deps: LeaderboardCommandDeps): CommandDefinition {
  return {
    name: 'leaderboard',
    defer: true,
    data: new SlashCommandBuilder()
      .setName('leaderboard')
      .setDescription('Show the server leaderboard')
      .addStringOption((option) =>
        option
          .setName('board')
          .setDescription('Which leaderboard to show')
          .addChoices(...METRIC_CHOICES),
      )
      .addIntegerOption((option) =>
        option.setName('page').setDescription('Page number').setMinValue(1),
      )
      .setDMPermission(false)
      .toJSON(),

    async execute(interaction: ChatInputCommandInteraction) {
      if (!interaction.guildId) {
        await interaction.editReply('This command only works inside a server.');
        return;
      }

      const metric = (interaction.options.getString('board') ?? 'xp') as LeaderboardMetric;
      const page = interaction.options.getInteger('page') ?? 1;
      const config = await deps.configs.get(interaction.guildId);

      if (!config.enabled) {
        await interaction.editReply('Leveling is turned off in this server.');
        return;
      }

      const result = await deps.boards.page({
        guildId: interaction.guildId,
        metric,
        page,
        config,
      });

      await interaction.editReply(
        render(result, config, interaction.guildId, interaction.user.id, interaction.guild?.name),
      );
    },
  };
}

export function createLeaderboardComponent(deps: LeaderboardCommandDeps): ComponentHandler {
  return {
    customIdPrefix: PREFIX,

    async handle(interaction, _ctx: ModuleContext) {
      if (!interaction.isButton() || !interaction.guildId) return;

      const parsed = parseCustomId(interaction.customId);
      if (!parsed) return;

      const config = await deps.configs.get(interaction.guildId);
      const isOwner = interaction.user.id === parsed.ownerId;

      // "Jump to me" is per-clicker by definition, so it always answers
      // privately — pulling the shared message to the presser's own page would
      // be the wrong behaviour even for the person who opened it.
      if (parsed.slot === 'me') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const page = await deps.boards.pageOf({
          guildId: interaction.guildId,
          metric: parsed.metric,
          userId: interaction.user.id,
          config,
        });

        if (page === null) {
          await interaction.editReply('You are not on this leaderboard yet.');
          return;
        }

        const result = await deps.boards.page({
          guildId: interaction.guildId,
          metric: parsed.metric,
          page,
          config,
        });
        await interaction.editReply(
          render(result, config, interaction.guildId, interaction.user.id, interaction.guild?.name),
        );
        return;
      }

      const result = await deps.boards.page({
        guildId: interaction.guildId,
        metric: parsed.metric,
        page: parsed.page,
        config,
      });

      const payload = render(
        result,
        config,
        interaction.guildId,
        parsed.ownerId,
        interaction.guild?.name,
      );

      if (isOwner) {
        await interaction.update(payload);
      } else {
        await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
      }
    },
  };
}

// ---------------------------------------------------------------------------

/**
 * The five navigation slots.
 *
 * THE SLOT IS PART OF THE CUSTOM ID, and that is not decoration.
 *
 * Discord requires every custom id in a message to be UNIQUE, and rejects the
 * whole message with 50035 otherwise. Encoding only the destination page
 * collides constantly: on a ONE-PAGE board, First and Last both target page 1;
 * on a two-page board, Next and Last both target page 2. Both are ordinary
 * states — a one-page board is what every new server sees — so `/leaderboard`
 * failed outright rather than in some corner case.
 *
 * discord.js does not check this client-side, so nothing catches it before the
 * API does. `buttons()` is therefore covered by a test asserting the ids are
 * distinct across a range of page counts, including one.
 */
const SLOTS = ['first', 'prev', 'me', 'next', 'last'] as const;
type Slot = (typeof SLOTS)[number];

interface ParsedId {
  readonly slot: Slot;
  readonly metric: LeaderboardMetric;
  /** The page this button navigates to. Ignored for the `me` slot. */
  readonly page: number;
  readonly ownerId: string;
}

function parseCustomId(customId: string): ParsedId | null {
  const [prefix, slot, metric, page, ownerId] = customId.split(':');
  if (prefix !== PREFIX || !slot || !metric || !ownerId) return null;
  if (!SLOTS.includes(slot as Slot)) return null;
  return {
    slot: slot as Slot,
    metric: metric as LeaderboardMetric,
    page: Math.max(1, Number(page) || 1),
    ownerId,
  };
}

function buttons(result: LeaderboardPage, ownerId: string): ActionRowBuilder<ButtonBuilder> {
  const id = (slot: Slot, page: number): string =>
    `${PREFIX}:${slot}:${result.metric}:${page}:${ownerId}`;

  const atFirst = result.page <= 1;
  const atLast = result.page >= result.totalPages;

  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(id('first', 1))
      .setLabel('First')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(atFirst),
    new ButtonBuilder()
      .setCustomId(id('prev', Math.max(1, result.page - 1)))
      .setLabel('Prev')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(atFirst),
    new ButtonBuilder()
      .setCustomId(id('me', result.page))
      .setLabel('Jump to me')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(id('next', result.page + 1))
      .setLabel('Next')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(atLast),
    new ButtonBuilder()
      .setCustomId(id('last', result.totalPages))
      .setLabel('Last')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(atLast),
  );
}

/** Exported for the regression test — see the SLOTS comment. */
export function customIdsFor(result: LeaderboardPage, ownerId: string): string[] {
  return buttons(result, ownerId)
    .toJSON()
    .components.map((c) => ('custom_id' in c ? String(c.custom_id) : ''));
}

interface RenderedBoard {
  readonly embeds: EmbedBuilder[];
  readonly components: ActionRowBuilder<ButtonBuilder>[];
}

function render(
  result: LeaderboardPage,
  config: GuildLevelingConfig,
  _guildId: string,
  ownerId: string,
  guildName: string | undefined,
): RenderedBoard {
  const embed = new EmbedBuilder()
    .setTitle(`${guildName ? `${guildName} — ` : ''}${metricLabel(result.metric)}`)
    .setDescription(
      result.entries.length === 0
        ? 'Nobody has earned anything on this board yet.'
        : result.entries
            .map((entry) => {
              const name = entry.displayName
                ? escapeMarkdown(entry.displayName)
                : `<@${entry.userId}>`;
              const departed = entry.isDeparted ? ' *(left)*' : '';
              return `${rankBadge(entry.rank)} **${name}**${departed} — ${formatValue(
                result.metric,
                entry.value,
              )}`;
            })
            .join('\n'),
    )
    .setFooter({
      text:
        `Page ${result.page} of ${result.totalPages} · ` +
        `${formatNumber(result.totalRanked)} ranked` +
        (config.hideDepartedMembers ? ' · departed members hidden' : ''),
    });

  return {
    embeds: [embed],
    // One row is always attached, even on a single-page board: "Jump to me"
    // is useful there too, and a disappearing control reads as a bug.
    components: [buttons(result, ownerId)],
  };
}

function formatValue(metric: LeaderboardMetric, value: number): string {
  switch (metric) {
    case 'voice':
      return formatDuration(value);
    case 'level':
      return `level ${formatNumber(value)}`;
    case 'messages':
      return `${formatNumber(value)} messages`;
    case 'reactions':
      return `${formatNumber(value)} reactions`;
    default:
      return `${formatNumber(value)} XP`;
  }
}
