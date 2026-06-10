'use strict';

/* Минимальный парсер SNBT (вывод команды `data get entity ...`):
   compound {a: 1b, id: "minecraft:stone"}, списки [..], типизированные
   массивы [B; 1b, 2b], числа с суффиксами b/s/l/f/d, строки в кавычках
   и без. Возвращает обычные JS-объекты. */

class Parser {
  constructor(text) {
    this.s = String(text);
    this.i = 0;
  }
  ws() {
    while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++;
  }
  value() {
    this.ws();
    const c = this.s[this.i];
    if (c === '{') return this.compound();
    if (c === '[') return this.list();
    if (c === '"' || c === "'") return this.quoted(c);
    return this.token();
  }
  compound() {
    this.i++; // {
    const obj = {};
    this.ws();
    if (this.s[this.i] === '}') { this.i++; return obj; }
    for (;;) {
      this.ws();
      let key;
      const c = this.s[this.i];
      if (c === '"' || c === "'") key = this.quoted(c);
      else {
        const start = this.i;
        while (this.i < this.s.length && /[^:\s]/.test(this.s[this.i])) this.i++;
        key = this.s.slice(start, this.i);
      }
      this.ws();
      if (this.s[this.i] !== ':') throw new Error('SNBT: ожидался ":" на позиции ' + this.i);
      this.i++;
      obj[key] = this.value();
      this.ws();
      const d = this.s[this.i];
      if (d === ',') { this.i++; continue; }
      if (d === '}') { this.i++; return obj; }
      throw new Error('SNBT: ожидался "," или "}" на позиции ' + this.i);
    }
  }
  list() {
    this.i++; // [
    this.ws();
    if (/^[BIL];/.test(this.s.slice(this.i, this.i + 2))) this.i += 2; // [B; [I; [L;
    const arr = [];
    this.ws();
    if (this.s[this.i] === ']') { this.i++; return arr; }
    for (;;) {
      arr.push(this.value());
      this.ws();
      const d = this.s[this.i];
      if (d === ',') { this.i++; continue; }
      if (d === ']') { this.i++; return arr; }
      throw new Error('SNBT: ожидался "," или "]" на позиции ' + this.i);
    }
  }
  quoted(q) {
    this.i++; // кавычка
    let out = '';
    while (this.i < this.s.length) {
      const ch = this.s[this.i++];
      if (ch === '\\') { out += this.s[this.i++]; continue; }
      if (ch === q) return out;
      out += ch;
    }
    throw new Error('SNBT: незакрытая строка');
  }
  token() {
    const start = this.i;
    while (this.i < this.s.length && /[^,\]}\s]/.test(this.s[this.i])) this.i++;
    const t = this.s.slice(start, this.i);
    if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?[bslfdBSLFD]?$/.test(t)) return parseFloat(t);
    if (t === 'true') return true;
    if (t === 'false') return false;
    return t;
  }
}

function parse(text) {
  return new Parser(text).value();
}

module.exports = { parse };
