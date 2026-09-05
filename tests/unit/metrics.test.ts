import { describe, expect, it } from 'vitest';
import { createMetrics, METRICS } from '../../src/platform/metrics/metrics.js';

/**
 * The exposition format is a contract with Prometheus, not a log line: a stray
 * character makes the whole scrape fail, and the failure shows up as "no data"
 * on a dashboard rather than as an error anywhere.
 */

describe('the metrics registry', () => {
  it('declares every metric even before anything has happened', () => {
    // A metric that only appears once it fires is one an operator cannot write
    // an alert against in advance.
    const output = createMetrics().render();
    for (const descriptor of METRICS) {
      expect(output, descriptor.name).toContain(`# TYPE ${descriptor.name} ${descriptor.type}`);
      expect(output).toContain(`# HELP ${descriptor.name} `);
    }
  });

  it('counts and renders a labelled counter', () => {
    const metrics = createMetrics();
    metrics.increment('enoki_xp_awarded_total', { source: 'message' });
    metrics.increment('enoki_xp_awarded_total', { source: 'message' });
    metrics.increment('enoki_xp_awarded_total', { source: 'voice' });

    expect(metrics.read('enoki_xp_awarded_total', { source: 'message' })).toBe(2);
    const output = metrics.render();
    expect(output).toContain('enoki_xp_awarded_total{source="message"} 2');
    expect(output).toContain('enoki_xp_awarded_total{source="voice"} 1');
  });

  it('adds an explicit amount, for totals that are not counts of one', () => {
    const metrics = createMetrics();
    metrics.increment('enoki_xp_amount_total', { source: 'message' }, 20);
    metrics.increment('enoki_xp_amount_total', { source: 'message' }, 22);
    expect(metrics.read('enoki_xp_amount_total', { source: 'message' })).toBe(42);
  });

  it('replaces rather than accumulates a gauge', () => {
    const metrics = createMetrics();
    metrics.gauge('enoki_guilds', 3);
    metrics.gauge('enoki_guilds', 5);
    expect(metrics.read('enoki_guilds')).toBe(5);
  });

  it('buckets a histogram cumulatively, as the format requires', () => {
    const metrics = createMetrics();
    metrics.observe('enoki_command_duration_ms', 30, { command: 'rank' });
    metrics.observe('enoki_command_duration_ms', 300, { command: 'rank' });

    const output = metrics.render();
    // 30ms falls in every bucket from 50 up; 300ms only from 500 up.
    expect(output).toContain('enoki_command_duration_ms_bucket{command="rank",le="50"} 1');
    expect(output).toContain('enoki_command_duration_ms_bucket{command="rank",le="500"} 2');
    expect(output).toContain('enoki_command_duration_ms_bucket{command="rank",le="+Inf"} 2');
    expect(output).toContain('enoki_command_duration_ms_sum{command="rank"} 330');
    expect(output).toContain('enoki_command_duration_ms_count{command="rank"} 2');
  });

  it('orders labels deterministically, so a series is one series', () => {
    const metrics = createMetrics();
    metrics.increment('enoki_commands_total', { outcome: 'ok', command: 'rank' });
    metrics.increment('enoki_commands_total', { command: 'rank', outcome: 'ok' });

    expect(metrics.render()).toContain('enoki_commands_total{command="rank",outcome="ok"} 2');
  });

  it('escapes the three characters that would corrupt a scrape', () => {
    const metrics = createMetrics();
    metrics.increment('enoki_discord_errors_total', { status: 'a"b\\c\nd' });
    const line = metrics
      .render()
      .split('\n')
      .find((l) => l.startsWith('enoki_discord_errors_total{'));
    expect(line).toBe('enoki_discord_errors_total{status="a\\"b\\\\c\\nd"} 1');
  });

  it('drops an undeclared metric instead of throwing on a hot path', () => {
    // A typo is a programming error, but the award path must not crash for it —
    // and the absence is immediately visible in /metrics.
    const metrics = createMetrics();
    expect(() => metrics.increment('enoki_typo_total')).not.toThrow();
    expect(metrics.render()).not.toContain('enoki_typo_total');
  });

  it('ends with a newline, which the format requires', () => {
    expect(createMetrics().render().endsWith('\n')).toBe(true);
  });
});
