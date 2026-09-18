import { createMemoryBlobStore } from '../src/media';

/** The in-memory store every integration test runs against (TESTING §3). */
export const blobs = createMemoryBlobStore();
