import {
  AttachmentBuilder,
  EmbedBuilder,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { CommandDefinition } from '../../../../platform/plugin/types.js';
import type { Database } from '../../../../platform/db/pool.js';
import { getRankSnapshot } from '../../application/queries/leaderboard.js';
import type { CardConfigRepository, CardRenderer, CardStyle } from '../../ports/cards.js';
import type { ConfigCache } from '../../ports/config.js';
import {
  ALLOWED_DISCORD_CDN_HOSTS,
  validateDiscordCdnUrl,
} from '../../domain/net/discordCdn.js';

/**
 * `/card` — personalising the rank card (roadmap M14).
 *
 * Member settings override guild settings, and NULL means inherit — so
 * `/card reset` is a delete rather than a write, and a server that later
 * changes its house colour changes it for everyone who never overrode it.
 */

export interface CardCommandDeps {
  readonly db: Database;
  readonly configs: ConfigCache;
  readonly cards: CardConfigRepository;
  readonly renderer: CardRenderer;
}

export function createCardCommand(deps: CardCommandDeps): CommandDefinition {
  return {
    name: 'card',
    defer: true,
    ephemeral: true,
    data: new SlashCommandBuilder()
      .setName('card')
      .setDescription('Personalise your rank card')
      .setDMPermission(false)
      .addSubcommand((sub) =>
        sub
          .setName('color')
          .setDescription('Set your accent colour')
          .addStringOption((option) =>
            option
              .setName('hex')
              .setDescription('A hex colour like #5865F2, or `none` to use the server default')
              .setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('background')
          .setDescription('Set your card background')
          .addAttachmentOption((option) =>
            option.setName('image').setDescription('Upload an image to use'),
          )
          .addStringOption((option) =>
            option.setName('url').setDescription('A Discord image URL, or `none` to clear'),
          ),
      )
      .addSubcommand((sub) => sub.setName('preview').setDescription('See your card'))
      .addSubcommand((sub) =>
        sub.setName('reset').setDescription('Go back to this server’s defaults'),
      )
      .toJSON(),

    async execute(interaction: ChatInputCommandInteraction) {
      const guildId = interaction.guildId;
      if (!guildId) {
        await interaction.editReply('This command only works inside a server.');
        return;
      }

      const config = await deps.configs.get(guildId);
      if (!config.cards.enabled) {
        await interaction.editReply(
          'Rank cards are turned off in this server. An admin can enable them with ' +
            '`/level config set cards.enabled on`.',
        );
        return;
      }

      const sub = interaction.options.getSubcommand();

      if (sub !== 'preview' && !config.cards.allowMemberCustomisation) {
        await interaction.editReply(
          'This server uses one card style for everyone. You can still use `/card preview`.',
        );
        return;
      }

      switch (sub) {
        case 'color':
          return setColor(interaction, deps, guildId);
        case 'background':
          return setBackground(interaction, deps, guildId);
        case 'reset':
          await deps.cards.clear(guildId, interaction.user.id);
          await interaction.editReply('Your card is back to this server’s defaults.');
          return;
        default:
          return preview(interaction, deps, guildId);
      }
    },
  };
}

async function setColor(
  interaction: ChatInputCommandInteraction,
  deps: CardCommandDeps,
  guildId: string,
): Promise<void> {
  const raw = interaction.options.getString('hex', true).trim().replace(/^#/, '');
  const existing = await deps.cards.get(guildId, interaction.user.id);

  if (/^(none|default|clear|reset)$/i.test(raw)) {
    await deps.cards.set(guildId, interaction.user.id, {
      accentColor: null,
      backgroundUrl: existing?.backgroundUrl ?? null,
    });
    await interaction.editReply('Your accent colour now follows the server default.');
    return;
  }

  if (!/^[0-9a-f]{6}$/i.test(raw)) {
    await interaction.editReply('That is not a hex colour. Try `#5865F2`, or `none`.');
    return;
  }

  await deps.cards.set(guildId, interaction.user.id, {
    accentColor: Number.parseInt(raw, 16),
    backgroundUrl: existing?.backgroundUrl ?? null,
  });
  await interaction.editReply(`Accent colour set to \`#${raw.toUpperCase()}\`.`);
}

async function setBackground(
  interaction: ChatInputCommandInteraction,
  deps: CardCommandDeps,
  guildId: string,
): Promise<void> {
  const attachment = interaction.options.getAttachment('image');
  const url = interaction.options.getString('url');
  const existing = await deps.cards.get(guildId, interaction.user.id);

  if (!attachment && (!url || /^(none|default|clear|reset)$/i.test(url.trim()))) {
    await deps.cards.set(guildId, interaction.user.id, {
      accentColor: existing?.accentColor ?? null,
      backgroundUrl: null,
    });
    await interaction.editReply('Background cleared.');
    return;
  }

  // An ATTACHMENT is the easy path and the one to steer people towards: Discord
  // has already hosted it, so the URL is on the CDN by construction.
  const candidate = attachment?.url ?? url ?? '';
  const validated = validateDiscordCdnUrl(candidate);

  if (!validated.ok) {
    await interaction.editReply(
      validated.reason === 'host_not_allowed'
        ? 'Backgrounds have to be images hosted on Discord. Upload the image with the ' +
            '`image` option instead of pasting a link — that puts it on Discord for you.\n' +
            `Accepted hosts: ${ALLOWED_DISCORD_CDN_HOSTS.map((h) => `\`${h}\``).join(', ')}.`
        : 'That does not look like a valid image link.',
    );
    return;
  }

  if (attachment && !(attachment.contentType ?? '').startsWith('image/')) {
    await interaction.editReply('That attachment is not an image.');
    return;
  }

  await deps.cards.set(guildId, interaction.user.id, {
    accentColor: existing?.accentColor ?? null,
    backgroundUrl: validated.url,
  });
  await interaction.editReply(
    'Background set. Note that if the original message is ever deleted, Discord may stop ' +
      'serving the image and your card will fall back to the plain background.',
  );
}

async function preview(
  interaction: ChatInputCommandInteraction,
  deps: CardCommandDeps,
  guildId: string,
): Promise<void> {
  const config = await deps.configs.get(guildId);
  const snapshot = await getRankSnapshot(deps.db, guildId, interaction.user.id, config);

  if (!snapshot) {
    await interaction.editReply('You have not earned any XP yet, so there is no card to show.');
    return;
  }

  const style = await resolveStyle(deps, guildId, interaction.user.id, config.cards);
  const member = await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);

  const png = await deps.renderer.render(
    {
      displayName: member?.displayName ?? interaction.user.username,
      avatarUrl: interaction.user.displayAvatarURL({ extension: 'png', size: 256 }),
      level: snapshot.level,
      rank: snapshot.rank,
      rankTotal: snapshot.rankTotal,
      xpIntoLevel: snapshot.xpIntoLevel,
      xpForNextLevel: snapshot.xpForNextLevel,
      totalXp: snapshot.totalXp,
      progressRatio: snapshot.progressRatio,
      isMaxLevel: snapshot.isMaxLevel,
    },
    style,
  );

  if (!png) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle('Card preview unavailable')
          .setDescription(
            'The card could not be rendered right now, so `/rank` will show an embed instead. ' +
              'Your settings were still saved.',
          ),
      ],
    });
    return;
  }

  await interaction.editReply({
    files: [new AttachmentBuilder(png, { name: 'rank.png' })],
  });
}

/**
 * Member over guild, field by field.
 *
 * Resolved per FIELD rather than per record: someone who set only a colour
 * should keep the server's background, not lose it.
 */
export async function resolveStyle(
  deps: Pick<CardCommandDeps, 'cards'>,
  guildId: string,
  userId: string,
  guildCards: { accentColor: number; backgroundUrl: string | null; allowMemberCustomisation: boolean },
): Promise<CardStyle> {
  const member = guildCards.allowMemberCustomisation
    ? await deps.cards.get(guildId, userId)
    : null;

  return {
    accentColor: member?.accentColor ?? guildCards.accentColor,
    backgroundUrl: member?.backgroundUrl ?? guildCards.backgroundUrl,
  };
}
