'use strict';

// Run locally: npm run generate:admin-token
// Copy the output directly into cPanel as ADMIN_STATUS_TOKEN. It is not saved.
const crypto = require('node:crypto');
process.stdout.write(`${crypto.randomBytes(32).toString('base64url')}\n`);
