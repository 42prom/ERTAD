try {
  var ertadTheme = localStorage.getItem('ertad.theme') || 'system';
  document.documentElement.dataset.theme = ertadTheme === 'dark' || (ertadTheme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
} catch (_) { document.documentElement.dataset.theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; }
