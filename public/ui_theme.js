(() => {
  let theme;
  try { theme = localStorage.getItem('dateher_ui_theme'); } catch {}
  if (!['light','dark'].includes(theme)) theme = 'light';
  function updateButton() {
    const button = document.getElementById('uiTheme');
    if (!button) return;
    button.textContent = window.uiLocale?.t(theme === 'light' ? 'Dark' : 'Light') || (theme === 'light' ? 'Dark' : 'Light');
    button.setAttribute('aria-pressed',String(theme === 'dark'));
    button.setAttribute('aria-label',window.uiLocale?.t('Theme') || 'Theme');
  }
  function setTheme(value) {
    if (!['light','dark'].includes(value)) return;
    theme=value; document.documentElement.dataset.theme=theme;
    try { localStorage.setItem('dateher_ui_theme',theme); } catch {}
    updateButton();
    window.dispatchEvent(new CustomEvent('ui-theme-change',{detail:{theme}}));
  }
  window.uiTheme={setTheme,toggle:()=>setTheme(theme==='light'?'dark':'light'),updateButton,get theme(){return theme;}};
  document.documentElement.dataset.theme=theme;
  window.addEventListener('ui-language-change',updateButton);
})();
