const root = document.documentElement;
const header = document.querySelector('[data-header]');
const themeButton = document.querySelector('[data-theme-toggle]');
const menuButton = document.querySelector('[data-menu-toggle]');
const mobileNav = document.querySelector('[data-mobile-nav]');

function updateHeader() {
  header?.classList.toggle('scrolled', window.scrollY > 10);
}

window.addEventListener('scroll', updateHeader, { passive: true });
updateHeader();

themeButton?.addEventListener('click', () => {
  const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
  root.dataset.theme = next;
  try { localStorage.setItem('night-shift-theme', next); } catch (_) {}
});

menuButton?.addEventListener('click', () => {
  const open = mobileNav?.classList.toggle('open') ?? false;
  menuButton.setAttribute('aria-expanded', String(open));
});

mobileNav?.querySelectorAll('a').forEach((link) => {
  link.addEventListener('click', () => {
    mobileNav.classList.remove('open');
    menuButton?.setAttribute('aria-expanded', 'false');
  });
});

const observer = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    entry.target.classList.add('visible');
    observer.unobserve(entry.target);
  }
}, { threshold: 0.12, rootMargin: '0px 0px -40px' });

document.querySelectorAll('[data-reveal]').forEach((element) => observer.observe(element));

const tabs = [...document.querySelectorAll('[data-preview-tab]')];
const panels = [...document.querySelectorAll('[data-preview-panel]')];

function selectPreview(name) {
  tabs.forEach((tab) => {
    const active = tab.dataset.previewTab === name;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  panels.forEach((panel) => {
    const active = panel.dataset.previewPanel === name;
    panel.hidden = !active;
    panel.classList.toggle('active', active);
  });
}

tabs.forEach((tab) => {
  tab.addEventListener('click', () => selectPreview(tab.dataset.previewTab));
  tab.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const offset = event.key === 'ArrowRight' ? 1 : -1;
    const next = tabs[(tabs.indexOf(tab) + offset + tabs.length) % tabs.length];
    next.focus();
    selectPreview(next.dataset.previewTab);
  });
});
