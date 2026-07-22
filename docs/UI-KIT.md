# UI-кит MinecraftUI — дизайн-система CONTROLGUI

Единственный визуальный слой проекта — самописный кит в стиле Minecraft Ore UI / Bedrock, целиком в одном файле [`../public/css/minecraft.css`](../public/css/minecraft.css) (~1100 строк, без препроцессоров и зависимостей). Интерактивные примитивы оживляются функциями из [`../public/js/app.js`](../public/js/app.js).

## 🥇 Золотое правило
**Используй ТОЛЬКО компоненты этого кита. Никогда не изобретай свои кнопки, поля, свитчи, чекбоксы, дропдауны, модалки, тосты, статус-индикаторы.**

- Визуальные **примитивы** — только классы кита (`.mc-btn`, `.fld`, `.mc-toggle`, `.mc-check`, `.mc-sel`, `.mc-slider`, `.modal-*`, `.toast`, `.status-dot`, `.pi`).
- **Layout-обёртки** (flex/grid-хелперы: `.btn-row`, `.form-grid`, `.toggle-row`, `.opt-card`, свои `display:flex`-контейнеры) — добавлять можно свободно.
- **Не** задавай инлайн `color`/`font`/`border`/`background` примитивам — только классы кита и токены (`var(--accent)` и т.п.). Новый акцентный цвет — только через тему.
- Все правки визуала идут в `minecraft.css`, а не в разрозненные inline-стили. Токены и `@font-face` не дублировать.

---

## Токены и темы
```
:root
  --font-ui   : 'Minecraft'      (обычный текст)      --card       : #2b2b2b
  --font-head : 'Minecraft Ten'  (заголовки)          --card-inset : #232323
                                                       --bd         : #454545 (рамки)
                                                       --sep        : #474747
```
`--accent`, `--accent-bright` и палитра primary-кнопки (`--btn-pc/prim/psh/pts`) **НЕ** заданы в `:root` — они приходят из **темы**. Класс темы висит на корневом элементе:
- `.theme-lime` — зелёный `#5cb53d` (по умолчанию), `.theme-blue` — синий `#4a93cf`.
- ⚠️ Без класса темы на корне все primary/accent-компоненты сломаны (невалидные переменные).

---

## Оживление: примитивы — это пара CSS + JS
Три интерактивных компонента **не работают** без JS-инициализации из `app.js`. В HTML они пустые.

| Компонент | HTML | Оживить | Читать состояние |
|---|---|---|---|
| Свитч | `<div class="mc-toggle" id="x"></div>` | `mkToggle($('#x'), initialOn)` | `$('#x').classList.contains('on')` |
| Слайдер | `<div class="mc-slider" id="y"></div>` | `const s = mkSlider($('#y'), {min,max,step,value,format,labelEl,onChange})` | `s.value` (контроллер: `set/setRange/refresh`) |
| Дропдаун | `<select class="fld" id="z">…</select>` | `enhanceSelectsIn(root)` (или `enhanceSelect($('#z'))`) | `$('#z').value` (нативный select жив); после **программной** установки value → `$('#z')._mcSync?.()` |

> `<div class="mc-toggle">` без `mkToggle` — пустой нерабочий квадрат. `<select>` без `enhanceSelect` на Linux/WebKitGTK — бел-на-бел, нечитаем.

Ещё: `initCycleButtons(root)` оживляет `.mc-cycle` (циклическая кнопка по `data-values`/`data-names`/`data-start`, значение в `dataset.value`). `applyIcons(root)` проставляет иконки (см. ниже) — **звать после вставки любой новой разметки с `data-ic`**.

---

## Компоненты

### Кнопки — `.mc-btn`
Пиксельный «чанк» с 3px-рамкой и тенью-подложкой снизу (нажатие = `translateY`).
```html
<button class="mc-btn primary"><i class="pi" data-ic="check"></i> Сохранить</button>
<button class="mc-btn">Отмена</button>
<button class="mc-btn danger"><i class="pi" data-ic="trash"></i> Удалить</button>
<button class="mc-btn sm sq" title="Иконка"><i class="pi" data-ic="edit"></i></button>
```
Модификаторы: `primary` (акцент), `accent` (жёлтая), `danger` (красная), `sm`/`lg` (размер), `sq` (квадратная иконка, 42px; `sm.sq` 38px), `block` (`width:100%`), `sel` (залипшее нажатие). Внутри — `<i class="pi">`. У кнопки `margin-bottom:6px` под тень-подложку — в тулбарах его гасят (`.tabbar .mc-btn{margin-bottom:0}` и т.п.).

### Поля ввода — `.fld`
Универсальный класс для `input`/`textarea`/`select`.
```html
<label class="mc-label">Имя сервера
  <input class="fld" placeholder="Мой сервер">
</label>
```
Обычно в `<label class="mc-label">` (колонка: подпись сверху, поле снизу). `textarea.fld` — `resize:vertical`. Поле пароля — обёртка `.pass-wrap` + кнопка-глаз `.pass-eye` (маска-иконка):
```html
<span class="pass-wrap">
  <input class="fld" type="password" id="pw">
  <button type="button" class="pass-eye" id="pw-eye" title="Показать пароль"></button>
</span>
```

### Дропдаун — `.mc-sel`
В разметке пишут обычный `<select class="fld">`; `enhanceSelect` рисует поверх `.mc-sel` (нативный select остаётся скрытым носителем value и события `change`). Не верстать `.mc-sel-*` руками — их строит JS.

### Свитч — `.mc-toggle`
72×28. Обычно в `.toggle-row` (label слева, свитч справа) внутри `.opt-card`:
```html
<div class="opt-card toggle-row">
  <span class="toggle-label">Включить X</span>
  <div class="mc-toggle" id="x"></div>
</div>
```
`mkToggle($('#x'))` в инициализации. Состояние — `.classList.contains('on')`.

### Слайдер — `.mc-slider`
Обычно в `.slider-block` (подпись, слайдер, значение):
```html
<div class="opt-card slider-block">
  <span class="opt-label">Память: <span class="slider-val" id="mem-val"></span></span>
  <div class="mc-slider" id="mem"></div>
</div>
```

### Чекбокс — `.mc-check`
Квадрат 24×24; класс `.on` показывает галочку. Тоглится вручную (нет mk-хелпера). Собирают через `querySelectorAll('.mc-check.on')`. Обёртка-строка `.check-row`.
```html
<label class="check-row"><span class="mc-check"><span class="tick"></span></span> Согласен</label>
```

### Карточки
- `.mc-card` — базовая (фон `--card` + рамка), `.inset` — тёмный вариант.
- `.opt-card` — тёмная подложка **специально под свитчи/слайдеры** в формах (`--card-inset` + внутренняя тень); `.opt-card .opt-label` — подпись.
- `.srv-card` + сетка `.srv-grid` (flex по центру; `.cols3` — grid в 3 колонки при >3 элементах) — карточки серверов/подключений.

### Модалка
```html
<div class="modal-wrap hidden" id="my-modal">
  <div class="modal">
    <div class="modal-head"><span>Заголовок</span>
      <button class="mc-btn sm" id="my-close"><i class="pi" data-ic="close"></i></button></div>
    <div class="modal-body"><!-- контент --></div>
    <div class="btn-row"><button class="mc-btn primary">ОК</button></div>
  </div>
</div>
```
`.modal-wrap` — фикс-оверлей с затемнением и центрированием (показ/скрытие через `.hidden`). ⚠️ **`.modal-body` имеет `white-space: pre-line`** (переносы `\n` в тексте рендерятся). Для обычной разметки с полями/строками **обязательно** сбрасывай `white-space:normal` (примеры: `#ra-card`, `#rc-modal`, `.ruser-modal`) — иначе появляются лишние пустоты от переносов в HTML.

### Статусы — `.status-dot` / `.st-*`
```html
<span class="rc-state"><span class="status-dot on"></span>В сети</span>
```
`.status-dot` (8px квадрат) + `.on`/`.warn`/`.err`/`.dl` (зелёный/жёлтый/красный/синий с glow). Текстовые цвета статуса сервера — `.st-running`/`.st-starting`/`.st-stopping`/`.st-stopped`/`.st-downloading`/`.st-error`/`.st-no-jar`/`.st-orphaned`. Чип статистики на главной — `.stat-chip`.

### Текст
`.section-title`/`.mc-head` (font-head, uppercase-трекинг), `.mc-title`/`.hero-title` (крупные с тенью), `.subtitle`/`.hint`/`.label-dim` (приглушённый серый), `.err` (красная строка ошибки под полем; `.err.ok` — зелёная; `.err:empty` схлопывается).

### Иконки — `.pi`
```html
<i class="pi" data-ic="folder"></i>
```
18×18 span-маска, красится в `currentColor`. `data-ic` = имя svg из [`../public/icons/`](../public/icons/) (Pixelarticons). `applyIcons(el)` проставляет `--i`; **без него иконка невидима** (тихий сбой). Динамически — `picon(name, color)` создаёт готовый `<i>`. Внутри `.mc-btn` — 17px, в `.sm` — 15px.

### Тосты
Только через `showToast(message, type)` из app.js — не собирать `.toast` руками. `type === 'ok'` → зелёный, **любой другой (или отсутствие) → красный** (легко случайно показать успех красным, забыв `'ok'`).

### Layout-хелперы (можно свободно комбинировать)
`.btn-row` (центрированный ряд кнопок), `.btn-row-left`, `.toggle-row`, `.check-row`, `.form-grid` (2 колонки), `.icon-row`, `.seg-btns`/`.seg` (сегмент-кнопки вместо select), `.pass-wrap`/`.pass-eye`.

---

## Ловушки
- **`modal-body { white-space: pre-line }`** — самая частая. Сбрасывать `white-space:normal` для разметки с полями.
- **`mkToggle`/`mkSlider`/`enhanceSelect` обязательны** — CSS без JS не работает.
- **`--accent`/`--btn-*` только в `.theme-*`** — нужен класс темы на корне.
- **Иконки `.pi` невидимы без `applyIcons`/`data-ic`** — тихий сбой, а не сломанная картинка.
- Глобальное `*{cursor:var(--cursor)!important}` перекрывает курсоры; I-beam в полях возвращается отдельным `!important` для `input/textarea` — помнить про это для новых кликабельных элементов.
- `-webkit-font-smoothing:antialiased` намеренный — на Linux/WebKitGTK `none` ломает шрифт. Не менять.
- Куча **embed-режимов** через классы на `<html>` (`html.embed`, `.embed-settings`, `.embed-editor`, `.embed-files`, `.embed-profile`, `.ingame`) прячут/меняют секции — при добавлении экранов проверять эти правила в CSS.

---

## Чек-лист «прежде чем добавить UI»
1. Нужный примитив уже есть в ките? → использовать его класс, ничего не изобретать.
2. Свитч/слайдер/`<select>`? → не забыть `mkToggle`/`mkSlider`/`enhanceSelectsIn`.
3. Вставил разметку с `data-ic`? → `applyIcons(newEl)`.
4. Верстаешь внутри `.modal-body`? → сбросить `white-space:normal`.
5. Новый цвет? → только через тему/токены, не инлайном.
6. Успех тоста? → `showToast(msg, 'ok')` (не забыть второй аргумент).
7. Состояние свитча/чекбокса читаешь? → по классу `.on`, не через `checked`.
