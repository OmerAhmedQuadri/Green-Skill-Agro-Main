import { syncReferenceData } from '../reference-data';
import { closeDb } from '../runtime';

// Every environment, after migrations (DEVELOPMENT §7).
const result = await syncReferenceData();
console.log('reference data synced', result);
await closeDb();
