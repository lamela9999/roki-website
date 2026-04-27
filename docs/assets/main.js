// ROKI Docs — interactive bits
(function () {
  'use strict';

  // Mobile sidebar toggle
  const toggle = document.querySelector('.menu-toggle');
  const sidebar = document.querySelector('.sidebar');
  const overlay = document.querySelector('.sidebar-overlay');
  function openSidebar() {
    sidebar?.classList.add('open');
    overlay?.classList.add('open');
  }
  function closeSidebar() {
    sidebar?.classList.remove('open');
    overlay?.classList.remove('open');
  }
  if (toggle) {
    toggle.addEventListener('click', () => {
      if (sidebar?.classList.contains('open')) closeSidebar();
      else openSidebar();
    });
  }
  overlay?.addEventListener('click', closeSidebar);
  // Close sidebar when clicking any link inside it (mobile)
  sidebar?.querySelectorAll('a').forEach((a) => {
    a.addEventListener('click', () => {
      if (window.innerWidth <= 860) closeSidebar();
    });
  });

  // Active TOC link highlighting on scroll
  const tocLinks = Array.from(document.querySelectorAll('.toc-link'));
  if (tocLinks.length) {
    const targets = tocLinks
      .map((link) => {
        const id = link.getAttribute('href')?.slice(1);
        const el = id ? document.getElementById(id) : null;
        return el ? { link, el } : null;
      })
      .filter(Boolean);

    function syncToc() {
      const headerH = 80;
      const scrollY = window.scrollY + headerH + 40;
      let active = targets[0];
      for (const t of targets) {
        if (t.el.offsetTop <= scrollY) active = t;
      }
      tocLinks.forEach((l) => l.classList.remove('active'));
      active?.link.classList.add('active');
    }
    syncToc();
    window.addEventListener('scroll', syncToc, { passive: true });
  }

  // Smooth scroll for in-page anchors
  document.querySelectorAll('a[href^="#"]').forEach((a) => {
    a.addEventListener('click', (e) => {
      const href = a.getAttribute('href');
      if (!href || href === '#') return;
      const el = document.querySelector(href);
      if (!el) return;
      e.preventDefault();
      const headerH = 80;
      const top = el.getBoundingClientRect().top + window.scrollY - headerH;
      window.scrollTo({ top, behavior: 'smooth' });
      history.replaceState(null, '', href);
    });
  });
})();
