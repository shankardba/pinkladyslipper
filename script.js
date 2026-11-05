// Top-right menu (Media / Music / Lyrics)
const menuToggle = document.getElementById('menuToggle');
const menuPanel = document.getElementById('menuPanel');

const setMenuOpen = (open) => {
  menuPanel.hidden = !open;
  menuToggle.setAttribute('aria-expanded', String(open));
  menuToggle.classList.toggle('is-open', open);
};

menuToggle.addEventListener('click', (event) => {
  event.stopPropagation();
  setMenuOpen(menuPanel.hidden);
});

document.addEventListener('click', (event) => {
  if (!menuPanel.hidden && !menuPanel.contains(event.target)) setMenuOpen(false);
});

menuPanel.querySelectorAll('a').forEach((link) => {
  link.addEventListener('click', () => setMenuOpen(false));
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !menuPanel.hidden) {
    setMenuOpen(false);
    menuToggle.focus();
  }
});

// Tour dates from the band's public Google Calendar, via the shows Worker.
// PROD uses the same-origin route; other hosts keep the hardcoded list.
const TEST_SHOWS_ENDPOINT = 'https://pls-shows-test.baseball4537.workers.dev/api/shows';
const showsEndpoint = {
  localhost: TEST_SHOWS_ENDPOINT,
  '127.0.0.1': TEST_SHOWS_ENDPOINT,
  'shankardba.github.io': TEST_SHOWS_ENDPOINT,
  'pinkladyslipper.net': '/api/shows',
  'www.pinkladyslipper.net': '/api/shows',
}[location.hostname];

const tourList = document.getElementById('tourList');

if (tourList && showsEndpoint) {
  const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  };
  const safeUrl = (url) => /^https?:\/\//i.test(url || '') ? url : null;
  const extLink = (className, text, href) => {
    const a = el('a', className, text);
    a.href = href; a.target = '_blank'; a.rel = 'noopener';
    return a;
  };
  const longDate = (show) => {
    const [y, m, d] = show.date.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  };
  const statusLabel = (show) => ({ cancelled: 'Cancelled', soldout: 'Sold out' })[show.status];

  // ----- Pop-up -----
  const dialog = document.getElementById('showDialog');
  const sheet = document.getElementById('showSheet');
  const showsById = new Map();
  let lastFocus = null;

  const fillDialog = (show) => {
    const poster = document.getElementById('showPoster');
    poster.replaceChildren();
    poster.style.removeProperty('--poster');
    setShape(null);
    if (show.image) {
      const img = el('img');
      img.alt = `Poster: ${show.title}, ${longDate(show)}`;
      img.addEventListener('load', () => setShape(img));
      img.addEventListener('error', () => { setShape(null); poster.replaceChildren(fallbackHeader(show)); });
      img.src = show.image;
      poster.style.setProperty('--poster', `url("${show.image}")`);
      poster.append(img);
      if (img.complete && img.naturalWidth) setShape(img);
    } else {
      poster.append(fallbackHeader(show));
    }

    document.getElementById('showDate').textContent = longDate(show) + (show.time ? ` · ${show.time}` : '');
    document.getElementById('showTitle').textContent = show.title;
    const address = document.getElementById('showAddress');
    address.textContent = show.address || show.city || '';
    address.hidden = !address.textContent;
    const details = document.getElementById('showDetails');
    details.textContent = show.details || '';
    details.hidden = !show.details;

    const actions = document.getElementById('showActions');
    actions.replaceChildren();
    const ticketUrl = safeUrl(show.ticketUrl);
    if (statusLabel(show)) actions.append(el('span', 'tour-status', statusLabel(show)));
    else if (ticketUrl) actions.append(extLink('btn btn-primary', 'Tickets', ticketUrl));
    const mapUrl = safeUrl(show.mapUrl);
    if (mapUrl) actions.append(extLink('btn btn-outline', 'Directions', mapUrl));
    const share = el('button', 'btn btn-outline show-share', 'Share');
    share.type = 'button';
    share.addEventListener('click', () => shareShow(show, share));
    actions.append(share);
    sheet.classList.toggle('is-cancelled', show.status === 'cancelled');
  };

  // Lay the pop-up out to suit the poster's shape: tall and square posters sit
  // beside the details on wide screens; wide ones go across the top. Phones
  // always stack. --ar (width / height) sizes the poster column exactly.
  const setShape = (img) => {
    sheet.classList.remove('is-tall', 'is-square', 'is-wide', 'no-image');
    if (!img) { sheet.classList.add('no-image'); sheet.style.removeProperty('--ar'); return; }
    const ar = img.naturalWidth / img.naturalHeight;
    sheet.style.setProperty('--ar', ar.toFixed(4));
    sheet.classList.add(ar < 0.85 ? 'is-tall' : ar <= 1.2 ? 'is-square' : 'is-wide');
  };

  // Load posters ahead of time so the pop-up opens at the right size.
  const preload = (url) => {
    const img = new Image();
    img.src = url;
    return img.decode ? img.decode().catch(() => {}) : Promise.resolve();
  };

  const fallbackHeader = (show) => {
    const [, m, d] = show.date.split('-');
    const box = el('div', 'show-poster-fallback');
    box.append(el('span', 'month', MONTHS[+m - 1]), el('span', 'day', String(+d)));
    return box;
  };

  const shareShow = async (show, button) => {
    const url = `${location.origin}${location.pathname}#show-${show.id}`;
    const text = `Pink Lady Slipper at ${show.title}, ${longDate(show)}`;
    if (navigator.share) {
      try { await navigator.share({ title: 'Pink Lady Slipper', text, url }); } catch { /* cancelled */ }
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      button.textContent = 'Link copied';
      setTimeout(() => { button.textContent = 'Share'; }, 2000);
    } catch { prompt('Copy this link:', url); }
  };

  const openShow = async (show, { fromHash = false } = {}) => {
    if (!dialog || !show || dialog.open) return;
    lastFocus = document.activeElement;
    // Wait briefly for the poster so the layout doesn't jump after opening.
    if (show.image) await Promise.race([preload(show.image), new Promise((r) => setTimeout(r, 400))]);
    fillDialog(show);
    if (!fromHash) history.replaceState(null, '', `#show-${show.id}`);
    document.body.style.overflow = 'hidden';
    dialog.showModal();
    sheet.scrollTop = 0;
  };

  const closeShow = () => {
    if (!dialog.open) return;
    sheet.classList.add('is-closing');
    setTimeout(() => {
      sheet.classList.remove('is-closing');
      sheet.style.transform = '';
      dialog.close();
    }, 180);
  };

  if (dialog) {
    dialog.addEventListener('close', () => {
      document.body.style.overflow = '';
      if (location.hash.startsWith('#show-')) history.replaceState(null, '', '#tour');
      if (lastFocus) lastFocus.focus();
    });
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); closeShow(); });
    dialog.addEventListener('click', (event) => { if (event.target === dialog) closeShow(); });
    document.getElementById('showClose').addEventListener('click', closeShow);

    // Swipe down to close on phones.
    let startY = null;
    sheet.addEventListener('touchstart', (e) => { startY = sheet.scrollTop <= 0 ? e.touches[0].clientY : null; }, { passive: true });
    sheet.addEventListener('touchmove', (e) => {
      if (startY === null) return;
      const dy = e.touches[0].clientY - startY;
      if (dy > 0) sheet.style.transform = `translateY(${dy}px)`;
    }, { passive: true });
    sheet.addEventListener('touchend', (e) => {
      if (startY === null) return;
      const dy = e.changedTouches[0].clientY - startY;
      startY = null;
      if (dy > 110) closeShow();
      else sheet.style.transform = '';
    });
  }

  // ----- List -----
  const renderShow = (show) => {
    const [y, m, d] = show.date.split('-');
    const li = el('li', 'tour-date has-details');
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    li.setAttribute('aria-haspopup', 'dialog');
    li.setAttribute('aria-label', `${show.title}, ${longDate(show)}. Show details`);

    if (show.image) {
      const thumb = el('img', 'tour-thumb');
      thumb.src = show.image; thumb.alt = ''; thumb.loading = 'lazy';
      thumb.addEventListener('error', () => thumb.remove());
      li.append(thumb);
    }

    const date = el('span', 'date', `${MONTHS[+m - 1]} ${d}, ${y}`);
    if (show.time) date.append(el('span', 'time', show.time));
    li.append(date);

    const venue = el('span', 'venue');
    venue.append(el('span', 'venue-name', show.title));
    if (show.city) venue.append(` — ${show.city}`);
    if (show.note) venue.append(el('span', 'note', show.note));
    li.append(venue);

    const ticketUrl = safeUrl(show.ticketUrl);
    if (statusLabel(show)) li.append(el('span', 'tour-status', statusLabel(show)));
    else if (ticketUrl) li.append(extLink('btn btn-small', 'Tickets', ticketUrl));
    li.append(el('span', 'tour-more', 'Details'));
    if (show.status === 'cancelled') li.classList.add('is-cancelled');

    li.addEventListener('click', (event) => { if (!event.target.closest('a')) openShow(show); });
    li.addEventListener('keydown', (event) => {
      if (event.target === li && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); openShow(show); }
    });
    return li;
  };

  const openFromHash = () => {
    const m = location.hash.match(/^#show-(.+)$/);
    if (m && showsById.has(m[1])) openShow(showsById.get(m[1]), { fromHash: true });
  };

  fetch(showsEndpoint)
    .then((res) => (res.ok ? res.json() : Promise.reject(res.status)))
    .then(({ shows }) => {
      shows.forEach((show) => {
        if (show.id) showsById.set(show.id, show);
        if (show.image) preload(show.image);
      });
      tourList.replaceChildren(...(shows.length
        ? shows.map(renderShow)
        : [el('li', 'tour-empty', 'No upcoming shows announced yet. Check back soon.')]));
      openFromHash();
    })
    .catch(() => { /* keep the hardcoded list */ });
  window.addEventListener('hashchange', openFromHash);
}

// Footer year
document.getElementById('year').textContent = new Date().getFullYear();

// The Trail (QR scavenger hunt) backend, picked by hostname. Hosts without one
// (including PROD, for now) keep the menu link hidden. It is also hidden on
// anything but a touch phone or tablet, since the game is played by scanning
// a QR code around town.
const TEST_TRAIL_URL = 'https://pls-trail-test.baseball4537.workers.dev/api/trail';
const trailUrl = {
  localhost: TEST_TRAIL_URL,
  '127.0.0.1': TEST_TRAIL_URL,
  'shankardba.github.io': TEST_TRAIL_URL,
}[location.hostname];

const trailItem = document.getElementById('trailItem');
if (trailItem && trailUrl && window.matchMedia('(hover: none) and (pointer: coarse)').matches) {
  document.getElementById('trailLink').href = trailUrl;
  trailItem.hidden = false;
}

// Mailing list backend, picked by hostname. PROD uses the same-origin route;
// other hosts keep the Join pill hidden and the unsubscribe form disabled.
const TEST_LIST_ENDPOINT = 'https://pls-list-test.baseball4537.workers.dev/api/list';
const listEndpoint = {
  localhost: TEST_LIST_ENDPOINT,
  '127.0.0.1': TEST_LIST_ENDPOINT,
  'shankardba.github.io': TEST_LIST_ENDPOINT,
  'pinkladyslipper.net': '/api/list',
  'www.pinkladyslipper.net': '/api/list',
}[location.hostname];

// Mailing list signup
const joinBlock = document.getElementById('joinBlock');

if (joinBlock) {
  if (listEndpoint) {
    const joinToggle = document.getElementById('joinToggle');
    const joinForm = document.getElementById('joinForm');

    // Must run before the deferred widget.js renders the form.
    joinForm.setAttribute('data-endpoint', listEndpoint);
    joinBlock.hidden = false;

    joinToggle.addEventListener('click', () => {
      const opening = joinForm.hidden;
      joinForm.hidden = !opening;
      joinToggle.setAttribute('aria-expanded', String(opening));
      joinToggle.classList.toggle('is-open', opening);
      if (opening) {
        const emailInput = joinForm.querySelector('input[type="email"]');
        if (emailInput) emailInput.focus();
      }
    });
  }
}

// Self-serve unsubscribe (unsubscribe.html)
const unsubForm = document.getElementById('unsubForm');

if (unsubForm) {
  const unsubStatus = document.getElementById('unsubStatus');
  const unsubButton = unsubForm.querySelector('button');
  const setUnsubStatus = (message, state) => {
    unsubStatus.textContent = message;
    if (state) unsubStatus.setAttribute('data-state', state);
    else unsubStatus.removeAttribute('data-state');
  };

  if (!listEndpoint) {
    unsubButton.disabled = true;
    setUnsubStatus('The mailing list isn’t open yet.', 'error');
  }

  unsubForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!listEndpoint) return;
    unsubButton.disabled = true;
    setUnsubStatus('Removing…', null);

    fetch(listEndpoint + '/unsubscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: unsubForm.email.value }),
    })
      .then((res) => res.json().then((data) => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (ok) {
          setUnsubStatus('You’ve been removed from the mailing list.', 'ok');
          unsubForm.reset();
        } else {
          setUnsubStatus(data && data.error ? data.error : 'Something went wrong.', 'error');
        }
      })
      .catch(() => setUnsubStatus('Network error — please try again.', 'error'))
      .then(() => { unsubButton.disabled = false; });
  });
}

// Media lightbox
const lightbox = document.getElementById('lightbox');

if (lightbox) {
  const lightboxImg = document.getElementById('lightboxImg');
  const lightboxClose = document.getElementById('lightboxClose');
  const lightboxPrev = document.getElementById('lightboxPrev');
  const lightboxNext = document.getElementById('lightboxNext');
  const galleryImages = Array.from(document.querySelectorAll('.media-item img'));
  let currentIndex = -1;

  const showIndex = (index) => {
    currentIndex = (index + galleryImages.length) % galleryImages.length;
    const img = galleryImages[currentIndex];
    lightboxImg.src = img.src;
    lightboxImg.alt = img.alt;
  };

  const openLightbox = (index) => {
    showIndex(index);
    lightbox.classList.add('active');
    lightbox.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
  };

  const closeLightbox = () => {
    lightbox.classList.remove('active');
    lightbox.setAttribute('aria-hidden', 'true');
    lightboxImg.src = '';
    document.body.style.overflow = '';
  };

  galleryImages.forEach((img, index) => {
    img.addEventListener('click', () => openLightbox(index));
  });

  lightboxClose.addEventListener('click', closeLightbox);

  if (lightboxPrev) {
    lightboxPrev.addEventListener('click', (event) => {
      event.stopPropagation();
      showIndex(currentIndex - 1);
    });
  }

  if (lightboxNext) {
    lightboxNext.addEventListener('click', (event) => {
      event.stopPropagation();
      showIndex(currentIndex + 1);
    });
  }

  lightbox.addEventListener('click', (event) => {
    if (event.target === lightbox) closeLightbox();
  });

  document.addEventListener('keydown', (event) => {
    if (!lightbox.classList.contains('active')) return;
    if (event.key === 'Escape') closeLightbox();
    if (event.key === 'ArrowLeft') showIndex(currentIndex - 1);
    if (event.key === 'ArrowRight') showIndex(currentIndex + 1);
  });
}
