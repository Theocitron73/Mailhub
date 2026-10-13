'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const pkg = require('../package.json');
const distDir = path.join(__dirname, '..', 'dist');

if (fs.existsSync(distDir)) {
  const files = fs.readdirSync(distDir);
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
}
