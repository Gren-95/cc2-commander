/**
 * The Tools tab's workshop panels, dispatched by subtab name.
 *
 * One entry point so `settings.ts` knows about "the workshop" rather than about each
 * panel in it. Each panel fetches its own data from `/api/workshop/*` when shown.
 */

import { renderWorkshopCost } from './workshop-cost';
import { renderWorkshopInventory } from './workshop-inventory';
import { renderWorkshopMaintenance } from './workshop-maintenance';
import { renderWorkshopStats } from './workshop-stats';

export function renderWorkshopPanel(name: string): void {
  if (name === 'stats') void renderWorkshopStats();
  else if (name === 'cost') void renderWorkshopCost();
  else if (name === 'maintenance') void renderWorkshopMaintenance();
  else if (name === 'inventory') void renderWorkshopInventory();
}
