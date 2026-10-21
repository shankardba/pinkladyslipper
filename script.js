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

// Footer year
document.getElementById('year').textContent = new Date().getFullYear();

// The Trail (QR scavenger hunt) backend, picked by hostname. Hosts without one
// (including PROD, for now) keep the menu link hidden.
const TEST_TRAIL_URL = 'https://pls-trail-test.baseball4537.workers.dev/api/trail';
const trailUrl = {
  localhost: TEST_TRAIL_URL,
  '127.0.0.1': TEST_TRAIL_URL,
  'shankardba.github.io': TEST_TRAIL_URL,
}[location.hostname];

const trailItem = document.getElementById('trailItem');
if (trailItem && trailUrl) {
  document.getElementById('trailLink').href = trailUrl;
  trailItem.hidden = false;
}

// Mailing list backend, picked by hostname. Hosts without one (including
// PROD, for now) keep the Join pill hidden and the unsubscribe form disabled.
const TEST_LIST_ENDPOINT = 'https://pls-list-test.baseball4537.workers.dev/api/list';
const listEndpoint = {
  localhost: TEST_LIST_ENDPOINT,
  '127.0.0.1': TEST_LIST_ENDPOINT,
  'shankardba.github.io': TEST_LIST_ENDPOINT,
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
