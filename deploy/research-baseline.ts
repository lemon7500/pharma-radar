// Free v2 projection: no source fetches or model calls during web startup.
import { publishResearchBaseline } from '@aihot/backend/research/backfill';
import { closeDb } from '@aihot/backend/db';
console.log(`research baseline projected: ${await publishResearchBaseline()}`);
await closeDb();
