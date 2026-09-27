/**
 * A run's budgets, as the agent and the configuration share them (kept apart
 * from the loop so `config.ts` can import the defaults without the agent's
 * whole import graph).
 */

export const DEFAULT_MAX_ACTIONS: number = 60;
export const DEFAULT_MAX_DECISIONS: number = 120;
