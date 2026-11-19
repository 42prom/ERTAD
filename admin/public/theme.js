try {
  var ertadTheme = localStorage.getItem('ertad.console.theme') || localStorage.getItem('ertad.theme') || 'system';
  document.documentElement.dataset.theme = ertadTheme === 'dark' || (ertadTheme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
} catch { document.documentElement.dataset.theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; }
