import { useCallback, useEffect, useState } from 'react';
import { ArrowUpRight, CheckCircle2, Circle, Layers3, LayoutDashboard, Palette, ShieldCheck, Users, Vote } from 'lucide-react';
import { Button, Dialog, Field } from './components/ui';
import { messages } from './i18n';

function stored(key: string, fallback: string) { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } }
function persist(key: string, value: string) { try { localStorage.setItem(key, value); } catch { /* Preferences remain usable without storage. */ } }
export function App() {
  const [locale, setLocale] = useState<'ka' | 'en'>(() => stored('ertad.locale', 'ka') === 'en' ? 'en' : 'ka');
  const [theme, setTheme] = useState(() => { const value = stored('ertad.theme', 'system'); return ['light', 'dark'].includes(value) ? value : 'system'; });
  const [page, setPage] = useState(() => location.hash === '#design' ? 'design' : 'overview');
  const [health, setHealth] = useState<'checking' | 'ready' | 'unavailable'>('checking');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [dialog, setDialog] = useState(false);
  const [notice, setNotice] = useState(false);
  const [mobileTheme, setMobileTheme] = useState('dark');
  const t = messages[locale];
  useEffect(() => { document.documentElement.lang = locale; persist('ertad.locale', locale); }, [locale]);
  useEffect(() => {
    persist('ertad.theme', theme);
    const media = matchMedia('(prefers-color-scheme: dark)');
    const sync = () => { document.documentElement.dataset.theme = theme === 'system' ? (media.matches ? 'dark' : 'light') : theme; };
    sync(); media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, [theme]);
  useEffect(() => {
    const sync = () => setPage(location.hash === '#design' ? 'design' : 'overview');
    window.addEventListener('hashchange', sync); return () => window.removeEventListener('hashchange', sync);
  }, []);
  const check = useCallback(async () => {
    setHealth('checking');
    try {
      const response = await fetch('/health/ready', { signal: AbortSignal.timeout(5000) });
      const body = await response.json();
      setHealth(response.ok && body.status === 'ready' ? 'ready' : 'unavailable');
    } catch { setHealth('unavailable'); }
  }, []);
  useEffect(() => { void check(); }, [check]);
  const samples = [
    { key: 'buttons', title: t.buttons, category: 'controls', content: <div className="actions"><Button onClick={() => setNotice(true)}>{t.primary}</Button><Button variant="secondary" onClick={() => setNotice(true)}>{t.secondary}</Button><Button disabled>{t.disabled}</Button></div> },
    { key: 'dialog', title: t.modal, category: 'controls', content: <Button variant="secondary" onClick={() => setDialog(true)}>{t.open}<ArrowUpRight size={16} /></Button> },
    { key: 'card', title: t.card, category: 'surfaces', content: <p>{t.cardText}</p> },
  ].filter(sample => (category === 'all' || sample.category === category) && sample.title.toLocaleLowerCase(locale).includes(query.toLocaleLowerCase(locale).trim()));
  return <div className="app-shell">
    <a className="skip-link" href="#content">{t.skip}</a>
    <aside className="sidebar">
      <a className="brand" href="#overview"><span className="brand-mark"><Layers3 size={24} /></span><span>ERTAD<small>{t.workspace}</small></span></a>
      <span className="nav-label">{t.foundation}</span>
      <nav aria-label={t.foundation}>
        <a href="#overview" aria-current={page === 'overview' ? 'page' : undefined}><LayoutDashboard size={19} />{t.overview}</a>
        <a href="#design" aria-current={page === 'design' ? 'page' : undefined}><Palette size={19} />{t.design}</a>
      </nav>
      <div className="sidebar-note"><ShieldCheck size={20} /><span>{t.local}</span></div>
    </aside>
    <div className="workspace">
      <header className="topbar"><span className="breadcrumb">ERTAD <span>/</span> {page === 'overview' ? t.overview : t.design}</span><div className="preferences">
        <label>{t.theme}<select value={theme} onChange={event => setTheme(event.target.value)}><option value="system">{t.system}</option><option value="light">{t.light}</option><option value="dark">{t.dark}</option></select></label>
        <label>{t.language}<select value={locale} onChange={event => setLocale(event.target.value as 'ka' | 'en')}><option value="ka">ქართული</option><option value="en">English</option></select></label>
      </div></header>
      <main id="content" tabIndex={-1}>
        <div className="page-heading"><span className="eyebrow">{t.eyebrow}</span><h1>{page === 'overview' ? t.title : t.galleryTitle}</h1><p>{page === 'overview' ? t.subtitle : t.galleryText}</p></div>
        {page === 'overview' ? <>
          <section className="health surface"><div><span className={`status-dot ${health}`} /><strong role="status">{t[health]}</strong><p>{t.local}</p></div><Button variant="secondary" disabled={health === 'checking'} onClick={() => void check()}>{t.retry}</Button></section>
          <h2 className="section-title">{t.principles}</h2>
          <div className="principles">{[[ShieldCheck, t.privacy, t.privacyText], [Users, t.together, t.togetherText], [Vote, t.participation, t.participationText]].map(([Icon, title, description]) => {
            const Glyph = Icon as typeof ShieldCheck;
            return <article className="surface principle" key={String(title)}><span className="icon-box"><Glyph size={22} /></span><h3>{String(title)}</h3><p>{String(description)}</p></article>;
          })}</div>
          <section className="surface roadmap"><h2>{t.next}</h2>{[t.phase0, t.phase1, t.phase2, t.phase3].map((phase, index) => <div className="phase" key={phase}>{index === 0 ? <CheckCircle2 size={20} /> : <Circle size={20} />}<span><small>0{index + 1}</small>{phase}</span><span className="badge">{index === 0 ? t.now : t.later}</span></div>)}</section>
        </> : <>
          <section className="surface gallery"><h2>{t.preview}</h2><p className="caption">{t.demo}</p><div className="filter-bar"><Field label={t.search} type="search" value={query} onChange={event => setQuery(event.target.value)} /><label>{t.filter}<select value={category} onChange={event => setCategory(event.target.value)}><option value="all">{t.all}</option><option value="controls">{t.controls}</option><option value="surfaces">{t.surfaces}</option></select></label><Button variant="secondary" onClick={() => { setQuery(''); setCategory('all'); }}>{t.reset}</Button></div><p className="caption" role="status">{t.results}: {samples.length}</p>
          {samples.length ? samples.map(sample => <div className="sample" key={sample.key}><h3>{sample.title}</h3>{sample.content}</div>) : <div className="empty">{t.empty}</div>}<p role="status">{notice ? t.example : ''}</p></section>
          <section className="surface mobile-section"><div><h2>{t.mobile}</h2><p>{t.mobileNote}</p><label>{t.theme}<select value={mobileTheme} onChange={event => setMobileTheme(event.target.value)}><option value="light">{t.light}</option><option value="dark">{t.dark}</option></select></label></div><div className="phone" data-family="mobile" data-theme={mobileTheme}><span className="phone-heading">ERTAD <ShieldCheck size={18} /></span><span className="eyebrow">{t.home}</span><h3>{t.welcome}</h3><p>{t.homeText}</p><div className="phone-card"><Users size={22} /><h3>{t.together}</h3><p>{t.togetherText}</p></div><span className="phone-pill">{t.home}</span></div></section>
        </>}
      </main>
      <footer className="page-footer">ERTAD <span>{t.demo}</span></footer>
    </div>
    <Dialog open={dialog} onClose={() => setDialog(false)} title={t.modal} closeLabel={t.close} footer={<Button onClick={() => setDialog(false)}>{t.close}</Button>}><p>{t.modalText}</p></Dialog>
  </div>;
}
