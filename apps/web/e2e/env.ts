import { fileURLToPath } from 'node:url';

export const PORT = 4173;
export const DATA_DIR = fileURLToPath(new URL('../.e2e-data/', import.meta.url));
