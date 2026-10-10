(() => {
  const read = key => { try { return localStorage.getItem(key); } catch { return null; } };
  const savedLanguage = read('dateher_ui_language');
  let language = ['en','zh-cn'].includes(savedLanguage) ? savedLanguage : (navigator.language.toLowerCase().startsWith('zh') ? 'zh-cn' : 'en');
  let dictionaries = {'en': {}, 'zh-cn': {}};
  const originals = new WeakMap();
  const attributes = new WeakMap();
  const normalize = s => String(s).trim();
  function t(key, fallback = key) {
    const text = normalize(key);
    const lookup=text.replace(/,$/,'').trim();
    if(dictionaries[language][lookup])return dictionaries[language][lookup];
    const lower=lookup.toLowerCase();
    if(dictionaries[language][lower])return dictionaries[language][lower];
    const invalid=text.match(/^(.*?) (格式错误|最多 6000 字符)$/);
    if(invalid)return language==='en'?(invalid[2]==='格式错误'?'Invalid '+invalid[1]:invalid[1]+' must contain at most 6000 characters'):text;
    const unsupported=text.match(/^(?:不允许的参数：|此工作流不支持 )(.*)$/);
    if(unsupported)return language==='en'?'Unsupported parameter: '+unsupported[1]:text;
    if (dictionaries[language][text]) return dictionaries[language][text];
    const variant = text.match(/^All pages use appearance_[a-z] \(Original (\d+) of (\d+)\)$/);
    if (variant && language === 'zh-cn') return `所有画面使用原装款式 ${variant[1]}（共 ${variant[2]} 款）`;
    const story = text.match(/^→ (.*?) 《(.*?)》$/);
    if (story) return '→ ' + t(story[2], story[1]);
    const fallbackStory = text.match(/^→ (.*?)：无专属包，回落通用模板$/);
    if (fallbackStory) return '→ ' + t(fallbackStory[1]) + (language === 'en' ? ': using general story' : '：使用通用剧情');
    const characterInfo = text.match(/^(.*?) - Body type: (.*)$/);
    if (characterInfo) return `${translateCharacter(characterInfo[1].replace(/ \(.*\)$/, ''))} · ${language === 'zh-cn' ? '体型：' : 'Body type: '}${characterInfo[2]}`;
    if (language === 'en') {
      const entry = Object.entries(dictionaries['zh-cn']).find(([, value]) => value === text);
      return entry ? entry[0] : /[\u3400-\u9fff]/.test(String(fallback)) ? 'Request failed. Please try again.' : fallback;
    }
    const pieces = text.split(',').map(s => normalize(s));
    if (pieces.length > 1 && pieces.every(s => !s || dictionaries[language][s])) return pieces.filter(Boolean).map(s => dictionaries[language][s]).join('、');
    const match = text.match(/^(\d+)\/(\d+) scenes$/);
    if (match) return `${match[1]}/${match[2]} 个场景`;
    if (/^\d+ scene$/.test(text)) return text.replace(' scene', ' 个场景');
    if (/^Tone: /.test(text)) return '性格：' + t(text.slice(6));
    if (/^\d+ tags/.test(text)) return text.replace(' tags', ' 个标签').replace('story pack:', '剧情包：').replace('无专属剧情包','无专属剧情包');
    if (/^Original \d+/.test(text)) return text.replace('Original ', '原装款式 ');
    return fallback;
  }
  function translateCharacter(name) {
    const catalog = window.CHARS || {};
    const english = Object.keys(catalog).find(key => key === name || catalog[key].chinese === name || catalog[key].cn === name || catalog[key].name_source?.chinese === name || Object.values(catalog[key].display_names || {}).includes(name)) || name;
    return catalog[english]?.display_names?.[language] || (language === 'zh-cn' ? (catalog[english]?.chinese || catalog[english]?.cn || english) : english);
  }
  function applyTranslations(root = document.body) {
    if (!root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.parentElement.closest('script,style,.char-item,.preview-box,.appearance-preview,.s-text,[data-ui-raw]')) continue;
      const current = node.nodeValue;
      const record = originals.get(node);
      const source = record && current === record.output ? record.source : current;
      const output = source.replace(source.trim(), t(source.trim()));
      if (output !== current) node.nodeValue = output;
      originals.set(node, {source, output});
    }
    root.querySelectorAll('[placeholder],[title],[aria-label]').forEach(el => {
      if (el.closest('.s-text,.appearance-preview,.preview-box')) return;
      const record = attributes.get(el) || {};
      ['placeholder','title','aria-label'].forEach(attr => {
        if (!el.hasAttribute(attr)) return;
        const current = el.getAttribute(attr);
        const old = record[attr];
        const source = old && old.output === current ? old.source : current;
        const output = t(source);
        if (current !== output) el.setAttribute(attr, output);
        record[attr] = {source,output};
      });
      attributes.set(el,record);
    });
    root.querySelectorAll('.char-item').forEach(el => {
      const en = el.querySelector('.en');
      if (!en) return;
      let display = el.querySelector('.ui-character-name');
      if (!display) { display = document.createElement('span'); display.className = 'ui-character-name'; el.append(display); }
      const name = translateCharacter(en.textContent);
      if (display.textContent !== name) display.textContent = name;
      el.title = display.textContent;
    });
    document.documentElement.lang = language;
    document.title = t('Date your gacha girl');
    const select = document.getElementById('uiLanguage');
    if (select) select.value = language;
  }
  function setLanguage(value) {
    if (!['en','zh-cn'].includes(value)) return;
    language = value;
    try { localStorage.setItem('dateher_ui_language',language); } catch {}
    applyTranslations();
    window.dispatchEvent(new CustomEvent('ui-language-change', {detail:{language}}));
    applyTranslations();
  }
  window.uiLocale = {t,translateCharacter,applyTranslations,setLanguage,get language(){return language;}};
  document.addEventListener('DOMContentLoaded', async () => {
    const toolbar = document.createElement('nav');
    toolbar.className = 'ui-toolbar'; toolbar.setAttribute('aria-label','Language');
    toolbar.innerHTML = '<label for="uiLanguage">Language</label><select id="uiLanguage"><option value="en" data-ui-raw>English</option><option value="zh-cn" data-ui-raw>简体中文</option></select><button type="button" class="ui-theme-toggle" id="uiTheme">Theme</button>';
    document.body.prepend(toolbar);
    toolbar.querySelector('select').addEventListener('change',event => setLanguage(event.target.value));
    document.getElementById('uiTheme').addEventListener('click',() => window.uiTheme.toggle());
    try { const response = await fetch('ui_catalog_zh.json'); if (!response.ok) throw new Error('catalog'); dictionaries = await response.json(); } catch { /* English remains usable if offline. */ }
    let scheduled = false;
    new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {scheduled=false;applyTranslations();});
    }).observe(document.body,{subtree:true,childList:true,characterData:true});
    applyTranslations();
    window.uiTheme.updateButton();
    window.dispatchEvent(new CustomEvent('ui-locale-ready'));
  });
})();
