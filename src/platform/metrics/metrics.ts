/**
 * Metrics (spec `08` §3, roadmap M8).
 *
 * WHY NOT `prom-client`. The spec named it, and it is a fine library — but what
 * this system actually needs is four counters and two histograms rendered in a
 * text format that is ~40 lines to produce. Against that, a dependency brings a
 * supply-chain surface, a version to keep current, and an API to learn. The same
 * trade already went the same way for the migration runner (recorded in
 * PROGRESS.md), so this is consistent rather than novel. If exemplars,
 * exponential histograms or pushgateway support are ever needed, swapping the
 * implementation behind `MetricsSink` is a composition-root change.
 *
 * THE RULE THAT MATTERS IS CARDINALITY. A label whose value is unbounded — a
 * guild id, a user id, a channel id — creates one time series per value and
 * will eventually exhaust memory here and storage in Prometheus. Every label
 * used in this file is drawn from a closed set (a deny code, a command name, a
 * job name), and that is enforced by review, so `guildId` must never appear.
 */

export type Labels = Readonly<Record<string, string>>;

export interface MetricsSink {
  increment(name: string, labels?: Labels, by?: number): void;
  gauge(name: string, value: number, labels?: Labels): void;
  /** Records a duration in milliseconds into that metric's buckets. */
  observe(name: string, milliseconds: number, labels?: Labels): void;
}

interface Descriptor {
  readonly name: string;
  readonly help: string;
  readonly type: 'counter' | 'gauge' | 'histogram';
}

/**
 * Declared up front so `/metrics` is self-documenting even before anything has
 * happened. A metric that only appears once it fires is one an operator cannot
 * write an alert against in advance.
 */
export const METRICS: readonly Descriptor[] = [
  { name: 'enoki_xp_awarded_total', help: 'XP awards committed, by source', type: 'counter' },
  { name: 'enoki_xp_amount_total', help: 'Total XP granted', type: 'counter' },
  { name: 'enoki_xp_denied_total', help: 'XP candidates denied, by gate reason', type: 'counter' },
  { name: 'enoki_levelups_total', help: 'Level-ups observed', type: 'counter' },
  { name: 'enoki_commands_total', help: 'Slash commands handled, by name and outcome', type: 'counter' },
  { name: 'enoki_command_duration_ms', help: 'Slash command handler duration', type: 'histogram' },
  { name: 'enoki_job_runs_total', help: 'Scheduled job runs, by name and outcome', type: 'counter' },
  { name: 'enoki_job_duration_ms', help: 'Scheduled job duration', type: 'histogram' },
  { name: 'enoki_reward_role_changes_total', help: 'Reward roles added or removed', type: 'counter' },
  { name: 'enoki_discord_errors_total', help: 'Discord API errors, by status', type: 'counter' },
  { name: 'enoki_voice_sessions_open', help: 'Voice sessions currently open', type: 'gauge' },
  { name: 'enoki_guilds', help: 'Guilds this process is connected to', type: 'gauge' },
];

/** Milliseconds. Chosen around Discord's 3-second interaction deadline. */
const BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 3000, 5000, 10000];

interface Series {
  readonly descriptor: Descriptor;
  readonly labels: Labels;
  value: number;
  /** Histogram only. */
  counts?: number[];
  sum?: number;
  count?: number;
}

export interface MetricsRegistry extends MetricsSink {
  render(): string;
  reset(): void;
  /** Test hook: the current value of one series. */
  read(name: string, labels?: Labels): number | undefined;
}

export function createMetrics(): MetricsRegistry {
  const byName = new Map(METRICS.map((d) => [d.name, d]));
  const series = new Map<string, Series>();

  const keyOf = (name: string, labels: Labels): string =>
    `${name}{${Object.keys(labels)
      .sort()
      .map((k) => `${k}=${labels[k] ?? ''}`)
      .join(',')}}`;

  const seriesFor = (name: string, labels: Labels): Series | null => {
    const descriptor = byName.get(name);
    // An undeclared metric is a programming error, not a runtime condition:
    // dropping it silently is better than throwing on a hot path, and the
    // absence shows up immediately in /metrics.
    if (!descriptor) return null;

    const key = keyOf(name, labels);
    let entry = series.get(key);
    if (!entry) {
      entry = { descriptor, labels, value: 0 };
      if (descriptor.type === 'histogram') {
        entry.counts = new Array<number>(BUCKETS.length).fill(0);
        entry.sum = 0;
        entry.count = 0;
      }
      series.set(key, entry);
    }
    return entry;
  };

  return {
    increment(name, labels = {}, by = 1) {
      const entry = seriesFor(name, labels);
      if (entry) entry.value += by;
    },

    gauge(name, value, labels = {}) {
      const entry = seriesFor(name, labels);
      if (entry) entry.value = value;
    },

    observe(name, milliseconds, labels = {}) {
      const entry = seriesFor(name, labels);
      if (!entry?.counts) return;
      entry.sum = (entry.sum ?? 0) + milliseconds;
      entry.count = (entry.count ?? 0) + 1;
      for (let i = 0; i < BUCKETS.length; i++) {
        const bucket = BUCKETS[i];
        if (bucket !== undefined && milliseconds <= bucket) {
          entry.counts[i] = (entry.counts[i] ?? 0) + 1;
        }
      }
    },

    read(name, labels = {}) {
      return series.get(keyOf(name, labels))?.value;
    },

    reset() {
      series.clear();
    },

    /** Prometheus text exposition format, version 0.0.4. */
    render() {
      const lines: string[] = [];

      for (const descriptor of METRICS) {
        const mine = [...series.values()].filter((s) => s.descriptor.name === descriptor.name);

        lines.push(`# HELP ${descriptor.name} ${descriptor.help}`);
        lines.push(`# TYPE ${descriptor.name} ${descriptor.type}`);

        if (mine.length === 0) {
          // Emit a zero so the series exists and an alert can be written
          // against it before the first occurrence.
          if (descriptor.type !== 'histogram') lines.push(`${descriptor.name} 0`);
          continue;
        }

        for (const entry of mine) {
          if (descriptor.type === 'histogram') {
            for (let i = 0; i < BUCKETS.length; i++) {
              lines.push(
                `${descriptor.name}_bucket${render({ ...entry.labels, le: String(BUCKETS[i]) })} ${
                  entry.counts?.[i] ?? 0
                }`,
              );
            }
            lines.push(
              `${descriptor.name}_bucket${render({ ...entry.labels, le: '+Inf' })} ${entry.count ?? 0}`,
            );
            lines.push(`${descriptor.name}_sum${render(entry.labels)} ${entry.sum ?? 0}`);
            lines.push(`${descriptor.name}_count${render(entry.labels)} ${entry.count ?? 0}`);
          } else {
            lines.push(`${descriptor.name}${render(entry.labels)} ${entry.value}`);
          }
        }
      }

      return `${lines.join('\n')}\n`;
    },
  };
}

function render(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  return `{${keys.map((k) => `${k}="${escapeLabel(labels[k] ?? '')}"`).join(',')}}`;
}

/** Backslash, double quote and newline are the three characters that need it. */
function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** A sink that records nothing, for tests and for modules run without metrics. */
export const noopMetrics: MetricsSink = {
  increment: () => {},
  gauge: () => {},
  observe: () => {},
};
