'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const pkg = require('../package.json');
const distDir = path.join(__dirname, '..', 'dist');

if (fs.existsSync(distDir)) {
  const files = fs.readdirSync(distDir);

  // 1. Windows: dist/latest.yml
  const exe = files.find((f) => f.endsWith('.exe') && !f.includes('unpacked'));
  if (exe) {
    const filePath = path.join(distDir, exe);
    const content = fs.readFileSync(filePath);
    const sha512 = crypto.createHash('sha512').update(content).digest('base64');
    const yml = `version: ${pkg.version}
files:
  - url: ${exe}
    sha512: ${sha512}
    size: ${content.length}
path: ${exe}
sha512: ${sha512}
releaseDate: ${new Date().toISOString()}
`;
    fs.writeFileSync(path.join(distDir, 'latest.yml'), yml, 'utf8');
    console.log(`Généré dist/latest.yml pour ${exe}`);
  }

  // 2. macOS: dist/latest-mac.yml
  const zips = files.filter((f) => f.endsWith('.zip') && !f.includes('unpacked'));
  if (zips.length) {
    const zipEntries = zips.map((zip) => {
      const filePath = path.join(distDir, zip);
      const content = fs.readFileSync(filePath);
      const sha512 = crypto.createHash('sha512').update(content).digest('base64');
      return {
        url: zip,
        sha512,
        size: content.length,
      };
    });

    const primary = zipEntries.find((z) => z.url.includes('arm64')) || zipEntries[0];

    const yml = `version: ${pkg.version}
files:
${zipEntries.map((z) => `  - url: ${z.url}\n    sha512: ${z.sha512}\n    size: ${z.size}`).join('\n')}
path: ${primary.url}
sha512: ${primary.sha512}
releaseDate: ${new Date().toISOString()}
`;
    fs.writeFileSync(path.join(distDir, 'latest-mac.yml'), yml, 'utf8');
    console.log(`Généré dist/latest-mac.yml pour ${zips.join(', ')}`);
  }
}
