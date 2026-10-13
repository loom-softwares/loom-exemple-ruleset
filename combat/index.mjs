// Entry point for the combat tracking pieces. main.mjs calls registerCombat() once at boot.
// Each registration is guarded on its own: one failure never blocks the others.

import { registerCombatInitiative } from './initiative.mjs';
import { registerCombatLabels } from './labels.mjs';
import { registerCombatPanel } from './tracker-window.mjs';

/**
 * Runs the three combat registrations. Returns which ones succeeded, for logging.
 * Never throws.
 */
export function registerCombat() {
  const steps = [
    ['initiative', registerCombatInitiative],
    ['labels', registerCombatLabels],
    ['panel', registerCombatPanel],
  ];
  const result = {};
  for (const [name, register] of steps) {
    try {
      result[name] = register() === true;
    } catch (err) {
      result[name] = false;
      try {
        console.warn(`[loom-demo-system] combat ${name} registration failed`, err);
      } catch {
        // No console: nothing else to do.
      }
    }
  }
  return result;
}
