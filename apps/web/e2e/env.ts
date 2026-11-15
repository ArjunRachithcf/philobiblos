import { fileURLToPath } from 'node:url';

/** The household tests start on an empty Shelf; the library tests on one with the sample seed imported. */
export const PORT = 4173;
export const SEEDED_PORT = 4174;
export const dataDir = (port: number) => fileURLToPath(new URL(`../.e2e-data-${port}/`, import.meta.url));
export const DATA_DIR = dataDir(PORT);
