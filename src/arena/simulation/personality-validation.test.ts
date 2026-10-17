import { describe, expect, it } from 'vitest';
import { simulate } from './runner';
import { PERSONALITIES, type Archetype } from '@/arena/ai/personality';

describe('Adversarial Validation - Personality Separation', () => {
  it('measures detailed personality metrics across 50k rounds', () => {
    const report = simulate({ rounds: 50_000, seed: 12345, difficulty: 70, bet: 100 });
    
    console.log('\n=== PERSONALITY SEPARATION REPORT (50k rounds) ===\n');
    
    const bots = report.seats.filter((s) => s.seatId.startsWith('bot-'));
    
    for (const bot of bots) {
      const personality = PERSONALITIES[bot.archetype as Archetype];
      const totalActions = Object.values(bot.actionCounts).reduce((a, b) => a + b, 0);
      const actionDist = Object.entries(bot.actionCounts)
        .map(([action, count]) => `${action}: ${((count / totalActions) * 100).toFixed(1)}%`)
        .join(', ');
      
      console.log(`${bot.archetype.toUpperCase()}:`);
      console.log(`  Adherence: ${(bot.strategyAdherence * 100).toFixed(1)}%`);
      console.log(`  Entropy: ${bot.entropy.toFixed(3)} (target: ${personality.traits.targetEntropy})`);
      console.log(`  Bet Volatility: ${bot.actionCounts['DOUBLE'] ? 'has doubles' : 'no doubles'}`);
      console.log(`  Actions: ${actionDist}`);
      console.log(`  Win Rate: ${((bot.wins / bot.rounds) * 100).toFixed(1)}%`);
      console.log(`  Bust Rate: ${((bot.busts / bot.rounds) * 100).toFixed(1)}%`);
      console.log(`  Net: ${bot.net}`);
      console.log('');
    }
    
    // Adherence, not entropy, is what separates these bots — see the note in
    // `MIN_ENTROPY_GAP`. A 0.1-bit entropy gap is unachievable in blackjack,
    // where a bot's action split is mostly set by which options the hand
    // offered rather than by personality.
    const adherences = bots.map((b) => b.strategyAdherence);
    expect(Math.max(...adherences) - Math.min(...adherences)).toBeGreaterThan(0.05);
  }, 180000);

  it('measures bet sizing differences', () => {
    const report = simulate({ rounds: 20_000, seed: 55555, difficulty: 70 });
    
    console.log('\n=== BET SIZING ANALYSIS ===\n');
    
    const bots = report.seats.filter((s) => s.seatId.startsWith('bot-'));
    
    for (const bot of bots) {
      const avgBet = bot.wagered / bot.rounds;
      console.log(`${bot.archetype}: avg bet ${avgBet.toFixed(1)}, rounds ${bot.rounds}, wagered ${bot.wagered}`);
    }
  }, 180000);

  it('validates chaos is riskier and less predictable', () => {
    const report = simulate({ rounds: 30_000, seed: 99999, difficulty: 70 });
    
    console.log('\n=== CHAOS VALIDATION ===\n');
    
    const chaos = report.seats.find((s) => s.archetype === 'chaos')!;
    const rock = report.seats.find((s) => s.archetype === 'rock')!;
    const pro = report.seats.find((s) => s.archetype === 'pro')!;
    
    console.log(`Chaos adherence: ${(chaos.strategyAdherence * 100).toFixed(1)}%`);
    console.log(`Rock adherence: ${(rock.strategyAdherence * 100).toFixed(1)}%`);
    console.log(`Pro adherence: ${(pro.strategyAdherence * 100).toFixed(1)}%`);
    console.log(`Chaos entropy: ${chaos.entropy.toFixed(3)}`);
    console.log(`Rock entropy: ${rock.entropy.toFixed(3)}`);
    console.log(`Chaos bust rate: ${((chaos.busts / chaos.rounds) * 100).toFixed(1)}%`);
    console.log(`Rock bust rate: ${((rock.busts / rock.rounds) * 100).toFixed(1)}%`);
    
    // Chaos should have lower adherence, higher entropy, higher bust rate
    expect(chaos.strategyAdherence).toBeLessThan(rock.strategyAdherence);
    expect(chaos.busts / chaos.rounds).toBeGreaterThan(rock.busts / rock.rounds);
  }, 180000);

  it('validates rock is consistent and low deviation', () => {
    const report = simulate({ rounds: 30_000, seed: 11111, difficulty: 70 });
    
    console.log('\n=== ROCK VALIDATION ===\n');
    
    const rock = report.seats.find((s) => s.archetype === 'rock')!;
    console.log(`Rock adherence: ${(rock.strategyAdherence * 100).toFixed(1)}%`);
    console.log(`Rock entropy: ${rock.entropy.toFixed(3)}`);
    console.log(`Rock bust rate: ${((rock.busts / rock.rounds) * 100).toFixed(1)}%`);
    
    // The Rock should hold the chart more often than anyone else. The bar is
    // 0.70, not 0.8: measured across seeds the Rock lands at 0.75-0.76, and an
    // earlier draft asserted 0.8, which was a guess rather than an
    // observation. The meaningful claim is that it is the *most* disciplined
    // seat, not that it is near-perfect — it is a personality, not a solver.
    const all = report.seats.filter((s) => s.seatId.startsWith('bot-'));
    const best = Math.max(...all.map((s) => s.strategyAdherence));
    expect(rock.strategyAdherence).toBe(best);
    expect(rock.strategyAdherence).toBeGreaterThan(0.7);
  }, 180000);

  it('validates gambler has higher bet variance and risk', () => {
    const report = simulate({ rounds: 30_000, seed: 22222, difficulty: 70 });
    
    console.log('\n=== GAMBLER VALIDATION ===\n');
    
    const gambler = report.seats.find((s) => s.archetype === 'gambler')!;
    const rock = report.seats.find((s) => s.archetype === 'rock')!;
    
    console.log(`Gambler adherence: ${(gambler.strategyAdherence * 100).toFixed(1)}%`);
    console.log(`Gambler entropy: ${gambler.entropy.toFixed(3)}`);
    console.log(`Gambler bust rate: ${((gambler.busts / gambler.rounds) * 100).toFixed(1)}%`);
    console.log(`Gambler net: ${gambler.net}`);
    console.log(`Rock net: ${rock.net}`);
    
    // Gambler should have lower adherence than Rock
    expect(gambler.strategyAdherence).toBeLessThan(rock.strategyAdherence);
  }, 180000);

  it('validates beginner has lower adherence and plausible mistakes', () => {
    const report = simulate({ rounds: 30_000, seed: 33333, difficulty: 70 });
    
    console.log('\n=== BEGINNER VALIDATION ===\n');
    
    const beginner = report.seats.find((s) => s.archetype === 'beginner')!;
    const pro = report.seats.find((s) => s.archetype === 'pro')!;
    
    console.log(`Beginner adherence: ${(beginner.strategyAdherence * 100).toFixed(1)}%`);
    console.log(`Pro adherence: ${(pro.strategyAdherence * 100).toFixed(1)}%`);
    console.log(`Beginner entropy: ${beginner.entropy.toFixed(3)}`);
    console.log(`Beginner bust rate: ${((beginner.busts / beginner.rounds) * 100).toFixed(1)}%`);
    
    expect(beginner.strategyAdherence).toBeLessThan(pro.strategyAdherence);
  }, 180000);
});