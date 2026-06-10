'use strict';
const zlib = require('zlib');

/* Минимальный читатель NBT (формат Minecraft: level.dat, playerdata/*.dat).
   Поддерживает gzip/zlib/без сжатия. Возвращает обычный JS-объект:
   compound -> объект, list/массивы -> Array, long -> Number (с потерей
   точности за пределами 2^53 — для игровых данных не критично). */

const TAG = {
  END: 0, BYTE: 1, SHORT: 2, INT: 3, LONG: 4, FLOAT: 5, DOUBLE: 6,
  BYTE_ARRAY: 7, STRING: 8, LIST: 9, COMPOUND: 10, INT_ARRAY: 11, LONG_ARRAY: 12,
};

class Reader {
  constructor(buf) { this.buf = buf; this.pos = 0; }
  i8() { return this.buf.readInt8(this.pos++); }
  u8() { return this.buf.readUInt8(this.pos++); }
  i16() { const v = this.buf.readInt16BE(this.pos); this.pos += 2; return v; }
  u16() { const v = this.buf.readUInt16BE(this.pos); this.pos += 2; return v; }
  i32() { const v = this.buf.readInt32BE(this.pos); this.pos += 4; return v; }
  i64() { const v = this.buf.readBigInt64BE(this.pos); this.pos += 8; return Number(v); }
  f32() { const v = this.buf.readFloatBE(this.pos); this.pos += 4; return v; }
  f64() { const v = this.buf.readDoubleBE(this.pos); this.pos += 8; return v; }
  str() { const len = this.u16(); const v = this.buf.toString('utf8', this.pos, this.pos + len); this.pos += len; return v; }
}

function readPayload(r, type) {
  switch (type) {
    case TAG.BYTE: return r.i8();
    case TAG.SHORT: return r.i16();
    case TAG.INT: return r.i32();
    case TAG.LONG: return r.i64();
    case TAG.FLOAT: return r.f32();
    case TAG.DOUBLE: return r.f64();
    case TAG.STRING: return r.str();
    case TAG.BYTE_ARRAY: {
      const n = r.i32(); const out = new Array(n);
      for (let i = 0; i < n; i++) out[i] = r.i8();
      return out;
    }
    case TAG.INT_ARRAY: {
      const n = r.i32(); const out = new Array(n);
      for (let i = 0; i < n; i++) out[i] = r.i32();
      return out;
    }
    case TAG.LONG_ARRAY: {
      const n = r.i32(); const out = new Array(n);
      for (let i = 0; i < n; i++) out[i] = r.i64();
      return out;
    }
    case TAG.LIST: {
      const itemType = r.u8();
      const n = r.i32();
      const out = new Array(n);
      for (let i = 0; i < n; i++) out[i] = readPayload(r, itemType);
      return out;
    }
    case TAG.COMPOUND: {
      const obj = {};
      for (;;) {
        const t = r.u8();
        if (t === TAG.END) return obj;
        const name = r.str();
        obj[name] = readPayload(r, t);
      }
    }
    default:
      throw new Error('Неизвестный NBT-тег: ' + type);
  }
}

function decompress(buf) {
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) return zlib.gunzipSync(buf);
  if (buf.length > 1 && buf[0] === 0x78) {
    try { return zlib.inflateSync(buf); } catch (e) { /* не zlib — читаем как есть */ }
  }
  return buf;
}

/* Разбирает NBT-буфер, возвращает корневой compound. */
function parse(rawBuf) {
  const r = new Reader(decompress(rawBuf));
  const rootType = r.u8();
  if (rootType !== TAG.COMPOUND) throw new Error('Ожидался корневой compound-тег');
  r.str(); // имя корня (обычно пустое)
  return readPayload(r, TAG.COMPOUND);
}

module.exports = { parse };
