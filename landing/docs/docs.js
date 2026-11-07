const root = document.documentElement;
const themeButton = document.querySelector('[data-theme-toggle]');
const progress = document.querySelector('[data-reading-progress]');

themeButton?.addEventListener('click', () => {
  const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
  root.dataset.theme = next;
  try { localStorage.setItem('night-shift-theme', next); } catch (_) {}
});

function updateProgress() {
  const distance = document.documentElement.scrollHeight - innerHeight;
  const value = distance > 0 ? Math.min(1, scrollY / distance) : 0;
  progress?.style.setProperty('--progress', `${value * 100}%`);
}

addEventListener('scroll', updateProgress, { passive: true });
addEventListener('resize', updateProgress);
updateProgress();

const current = location.pathname.split('/').pop() || 'index.html';
document.querySelectorAll('a[href^="./"]').forEach((link) => {
  if (link.getAttribute('href').slice(2) === current) link.setAttribute('aria-current', 'page');
});
