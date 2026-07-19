'use strict';
/* Генерация самоподписанного X.509-сертификата на чистом Node (без openssl и
   зависимостей) — для HTTPS-листенера удалённого доступа. Собираем DER-структуру
   TBSCertificate вручную (ASN.1), подписываем RSA-SHA256 через crypto.
   Работает одинаково на Windows/Linux/macOS. */
const crypto = require('crypto');

// ---------- DER-кодирование (tag-length-value) ----------
function derLen(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  while (n > 0) { bytes.unshift(n & 0xff); n >>= 8; }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
function tlv(tag, value) { return Buffer.concat([Buffer.from([tag]), derLen(value.length), value]); }
const seq = (...parts) => tlv(0x30, Buffer.concat(parts));
const set = (...parts) => tlv(0x31, Buffer.concat(parts));
const ctx = (n, ...parts) => tlv(0xa0 | n, Buffer.concat(parts)); // [n] EXPLICIT (constructed)

function derInt(buf) {
  // INTEGER: положительное число — если старший бит установлен, добавляем ведущий 0x00
  let b = Buffer.isBuffer(buf) ? buf : Buffer.from([buf]);
  let i = 0;
  while (i < b.length - 1 && b[i] === 0 && !(b[i + 1] & 0x80)) i += 1; // убрать лишние нули
  b = b.slice(i);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
}
function derOid(oid) {
  const parts = oid.split('.').map(Number);
  const bytes = [parts[0] * 40 + parts[1]];
  for (let i = 2; i < parts.length; i += 1) {
    // base-128: младший септет последним, у всех кроме последнего установлен 8-й бит
    const sept = [];
    let x = parts[i];
    do { sept.unshift(x & 0x7f); x = Math.floor(x / 128); } while (x > 0);
    for (let j = 0; j < sept.length - 1; j += 1) sept[j] |= 0x80;
    bytes.push(...sept);
  }
  return tlv(0x06, Buffer.from(bytes));
}
const derNull = () => Buffer.from([0x05, 0x00]);
const derBool = (v) => Buffer.from([0x01, 0x01, v ? 0xff : 0x00]);
const derUtf8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'));
const derOctet = (buf) => tlv(0x04, buf);
function derBitString(buf, unusedBits) {
  return tlv(0x03, Buffer.concat([Buffer.from([unusedBits || 0]), buf]));
}
function derUtcTime(d) {
  const p = (n) => String(n).padStart(2, '0');
  const s = p(d.getUTCFullYear() % 100) + p(d.getUTCMonth() + 1) + p(d.getUTCDate())
    + p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + 'Z';
  return tlv(0x17, Buffer.from(s, 'ascii'));
}

// ---------- составные части сертификата ----------
const OID_SHA256_RSA = '1.2.840.113549.1.1.11';
const OID_CN = '2.5.4.3';
const OID_SAN = '2.5.29.17';
const OID_BASIC = '2.5.29.19';
const OID_KEY_USAGE = '2.5.29.15';
const OID_EXT_KEY_USAGE = '2.5.29.37';
const OID_SERVER_AUTH = '1.3.6.1.5.5.7.3.1';

const algSha256Rsa = () => seq(derOid(OID_SHA256_RSA), derNull());
const nameCN = (cn) => seq(set(seq(derOid(OID_CN), derUtf8(cn))));

function ipToBytes(ip) {
  const m = String(ip).match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  const b = m.slice(1).map(Number);
  return b.every((x) => x >= 0 && x <= 255) ? Buffer.from(b) : null;
}

/* subjectAltName: dNSName [2] IA5String, iPAddress [7] OCTET STRING */
function sanExtension(dnsNames, ips) {
  const entries = [];
  for (const d of dnsNames) entries.push(tlv(0x82, Buffer.from(d, 'ascii')));
  for (const ip of ips) { const b = ipToBytes(ip); if (b) entries.push(tlv(0x87, b)); }
  return seq(derOid(OID_SAN), derOctet(seq(...entries)));
}

function extension(oid, critical, valueDer) {
  return critical
    ? seq(derOid(oid), derBool(true), derOctet(valueDer))
    : seq(derOid(oid), derOctet(valueDer));
}

/* Сгенерировать самоподписанный серт.
   opts: { commonName, days, dnsNames: [], ips: [] }
   Возвращает { certPem, keyPem, fingerprint } (fingerprint — SHA-256 DER, hex без двоеточий). */
function generate(opts) {
  const o = opts || {};
  const cn = o.commonName || 'CONTROLGUI';
  const days = o.days || 3650;
  const dnsNames = Array.from(new Set(['localhost', ...(o.dnsNames || [])]));
  const ips = Array.from(new Set(['127.0.0.1', ...(o.ips || [])])).filter((ip) => ipToBytes(ip));

  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });

  // серийник: 15 случайных байт (положительный INTEGER)
  const serial = Buffer.concat([Buffer.from([0x01]), crypto.randomBytes(15)]);

  const now = new Date(Date.now() - 24 * 3600 * 1000); // notBefore: сутки назад (рассинхрон часов)
  const till = new Date(Date.now() + days * 24 * 3600 * 1000);

  const extsDer = ctx(3, seq(
    extension(OID_BASIC, true, seq()),                                  // basicConstraints CA:false
    extension(OID_KEY_USAGE, true, derBitString(Buffer.from([0xa0]), 5)), // digitalSignature+keyEncipherment
    extension(OID_EXT_KEY_USAGE, false, seq(derOid(OID_SERVER_AUTH))),  // serverAuth
    sanExtension(dnsNames, ips)                                          // SAN
  ));

  const tbs = seq(
    ctx(0, derInt(2)),        // version v3
    derInt(serial),
    algSha256Rsa(),
    nameCN(cn),               // issuer
    seq(derUtcTime(now), derUtcTime(till)),
    nameCN(cn),               // subject = issuer (самоподписанный)
    spkiDer,                  // SubjectPublicKeyInfo — готовый DER из crypto
    extsDer
  );

  const signature = crypto.sign('sha256', tbs, privateKey);
  const certDer = seq(tbs, algSha256Rsa(), derBitString(signature, 0));

  const b64 = certDer.toString('base64').replace(/(.{64})/g, '$1\n').trim();
  const certPem = '-----BEGIN CERTIFICATE-----\n' + b64 + '\n-----END CERTIFICATE-----\n';
  const fingerprint = crypto.createHash('sha256').update(certDer).digest('hex');

  // самопроверка: Node обязан распарсить собранный DER, а подпись — сойтись с нашим
  // же публичным ключом (битый DER/подпись = молча сломанный HTTPS у пользователя).
  // Именно verify, а НЕ checkIssued: последний требует keyCertSign в keyUsage издателя,
  // которого у листового серта нет.
  const parsed = new crypto.X509Certificate(certPem);
  if (!parsed.verify(parsed.publicKey)) throw new Error('selfsigned: подпись сертификата не прошла самопроверку');

  return { certPem, keyPem, fingerprint };
}

module.exports = { generate };
