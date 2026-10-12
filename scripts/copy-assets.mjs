import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(projectRoot, 'src/server/admin.html');
const destination = resolve(projectRoot, 'dist/server/admin.html');

await mkdir(dirname(destination), { recursive: true });
await copyFile(source, destination);
console.log('Copied src/server/admin.html to dist/server/admin.html');
