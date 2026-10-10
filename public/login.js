let loginBusy=false;
const form = document.getElementById('loginForm');
form.addEventListener('submit', async event => {
  event.preventDefault();
  const button = document.getElementById('loginButton');
  const status = document.getElementById('loginStatus');
  if(loginBusy){status.dataset.errorKey='An action is already running. Please wait.';status.textContent=window.uiLocale.t(status.dataset.errorKey);return;}
  loginBusy=true;button.disabled = true; status.textContent = '';delete status.dataset.errorKey;button.setAttribute('aria-busy','true');
  sessionStorage.removeItem('dateher_pending');
  try {
    const response = await fetch('/api/auth/login', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:form.username.value.trim(),password:form.password.value}),cache:'no-store'});
    const data = await response.json();
    if (!response.ok || typeof data.token !== 'string' || !data.user) {
      status.dataset.errorKey = response.status === 429 ? 'Too many requests' : 'Invalid username or password';
      throw new Error(status.dataset.errorKey);
    }
    sessionStorage.setItem('dateher_token',data.token);
    form.password.value=''; location.replace('/DateHerGen?v=20261003-mobile2');
  } catch (error) {
    status.dataset.errorKey = error instanceof TypeError ? 'Failed to fetch' : status.dataset.errorKey || 'Login failed';
    status.textContent = window.uiLocale.t(status.dataset.errorKey);
  } finally {loginBusy=false;button.disabled=false;button.setAttribute('aria-busy','false');}
});
window.addEventListener('ui-language-change', () => {
  const status = document.getElementById('loginStatus');
  if (status.textContent && status.dataset.errorKey) status.textContent=window.uiLocale.t(status.dataset.errorKey);
});
