#!/usr/bin/env node
/*
 * ARCADE — one-time HTTPS certificate maker.
 *
 * Java phone (J2ME) games run on CheerpJ, which ONLY starts on a "secure" page.
 * http://localhost counts as secure, but a plain http://192.168.x.x LAN address
 * does NOT — so Java fails on TVs and phones reached over the network. Serving
 * ARCADE over HTTPS (even with a self-signed certificate you accept once) makes
 * every page a secure context, so Java works over the LAN too.
 *
 * This creates a self-signed certificate into the certs/ folder, valid for
 * localhost and your current LAN IP addresses. It needs `openssl` on your PATH
 * (preinstalled on macOS/Linux; on Windows it ships with Git for Windows).
 *
 *   node make-cert.js
 *
 * Then start ARCADE with HTTPS enabled:
 *   Windows :  set ARCADE_HTTPS=1 && node server.js
 *   Mac/Linux: ARCADE_HTTPS=1 node server.js
 *
 * Open https://<your-LAN-IP>:8443 on the TV/phone and accept the one-time warning.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const DIR  = path.join(ROOT, 'certs');

function lanIps() {
  const out = ['127.0.0.1'];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces))
    for (const ni of ifaces[name] || [])
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
  return out;
}

(function () {
  fs.mkdirSync(DIR, { recursive: true });
  const ips = lanIps();
  const sans = ['DNS:localhost', ...ips.map(ip => 'IP:' + ip)].join(',');
  const cnf =
    '[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n' +
    '[dn]\nCN=ARCADE\n' +
    '[v3]\nsubjectAltName=' + sans + '\nbasicConstraints=CA:FALSE\n';
  const cnfPath = path.join(DIR, 'openssl.cnf');
  fs.writeFileSync(cnfPath, cnf);

  console.log('\nARCADE HTTPS certificate');
  console.log('Valid for: ' + sans + '\n');
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', path.join(DIR, 'key.pem'),
      '-out',    path.join(DIR, 'cert.pem'),
      '-days', '3650', '-config', cnfPath,
    ], { stdio: 'inherit' });
  } catch (e) {
    console.error('\nCould not run openssl (' + e.message + ').');
    console.error('Install openssl and try again, or create certs/key.pem + certs/cert.pem yourself.\n');
    try { fs.unlinkSync(cnfPath); } catch (_) {}
    process.exit(1);
  }
  try { fs.unlinkSync(cnfPath); } catch (_) {}

  console.log('\nDone. Created certs/key.pem and certs/cert.pem');
  console.log('Start ARCADE with HTTPS:');
  console.log('  Windows :  set ARCADE_HTTPS=1 && node server.js');
  console.log('  Mac/Linux: ARCADE_HTTPS=1 node server.js');
  console.log('Then open https://' + (lanIps()[1] || 'localhost') + ':8443 on the TV/phone (accept the one-time warning).\n');
})();
