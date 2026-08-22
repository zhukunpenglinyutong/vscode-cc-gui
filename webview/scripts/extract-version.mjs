#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Read version from VSCode extension package.json
const pkgPath = path.resolve(__dirname, '../../package.json');
let version = '0.1.0';
if (fs.existsSync(pkgPath)) {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  version = pkg.version ?? version;
}

console.log(`Found version: ${version}`);

const versionDir = path.join(__dirname, '../src/version');
if (!fs.existsSync(versionDir)) {
  fs.mkdirSync(versionDir, { recursive: true });
}

const versionFilePath = path.join(versionDir, 'version.ts');
fs.writeFileSync(versionFilePath, `// Auto-generated\nexport const APP_VERSION = '${version}';\n`);
console.log(`Version file created at: ${versionFilePath}`);
