/* ============================================================
   UI VAULT — SCRIPT — PART 1
   Config, Supabase Client, Loading Helper, UX Rate Limiter
   ============================================================ */

// ===== CONFIGURATION (REPLACE WITH YOUR OWN SECRETS VIA ENV) =====
const CONFIG = {
  // These should be loaded from environment variables in production.
  // For now, replace with your own test keys.
  SUPABASE_URL: "https://umfwvksnaqgtjvkgpgow.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_W9XISd-bgINvMvzqe6Xe3g_vBxyTa8p", // Replace with your anon key
  PAYSTACK_PUBLIC_KEY: "pk_live_04e7f9130c3908734b3e8f8b087143d165c5722b", // ⚠ USE TEST KEY FOR DEV
  MAX_AUTH_ATTEMPTS: 5,
  AUTH_WINDOW_MS: 300000 // 5 minutes
};

// ===== SUPABASE CLIENT =====
const supabaseClient = window.supabase.createClient(
  CONFIG.SUPABASE_URL,
  CONFIG.SUPABASE_ANON_KEY
);

// ===== GLOBALS =====
let TEMPLATES = [];
let currentUser = null;
let currentDetailTemplate = null;
let cart = [];

// ===== UX RATE LIMITER (client-side only – for UX, not security) =====
const rateLimits = {};

function checkRateLimit(key, maxAttempts = CONFIG.MAX_AUTH_ATTEMPTS, windowMs = CONFIG.AUTH_WINDOW_MS) {
  const now = Date.now();
  if (!rateLimits[key]) {
    rateLimits[key] = { attempts: 0, resetAt: now + windowMs };
  }
  if (now > rateLimits[key].resetAt) {
    rateLimits[key] = { attempts: 0, resetAt: now + windowMs };
  }
  rateLimits[key].attempts++;
  return rateLimits[key].attempts <= maxAttempts;
}

function getRemainingAttempts(key) {
  if (!rateLimits[key]) return CONFIG.MAX_AUTH_ATTEMPTS;
  const now = Date.now();
  if (now > rateLimits[key].resetAt) return CONFIG.MAX_AUTH_ATTEMPTS;
  return CONFIG.MAX_AUTH_ATTEMPTS - rateLimits[key].attempts;
}

// ===== LOADING HELPER =====
function showLoading(el, text = 'Loading...') {
  const original = el.innerHTML;
  const originalDisabled = el.disabled;
  el.disabled = true;
  el.innerHTML = text;
  return function restore() {
    el.disabled = originalDisabled;
    el.innerHTML = original;
  };
}

// ===== ADMIN CHECK (optional) =====
async function isAdmin() {
  if (!currentUser) return false;
  try {
    const { data, error } = await supabaseClient
      .from('users')
      .select('role')
      .eq('id', currentUser.id)
      .single();
    if (error || !data) return false;
    return data.role === 'admin';
  } catch {
    return false;
  }
}
/* ============================================================
   UI VAULT — SCRIPT — PART 2
   Session Management, Unlock Helpers, Sync
   ============================================================ */

// ===== SESSION LISTENER =====
supabaseClient.auth.onAuthStateChange((event, session) => {
  currentUser = session?.user || null;
  updateProfileNavLinks();
  if (event === 'SIGNED_IN' && currentUser) {
    syncPurchasesToLocal();
  }
});

function updateProfileNavLinks() {
  const navProfile = document.getElementById('navProfile');
  const mobileNavProfile = document.getElementById('mobileNavProfile');
  const show = !!currentUser;
  if (navProfile) navProfile.style.display = show ? 'inline-block' : 'none';
  if (mobileNavProfile) mobileNavProfile.style.display = show ? 'block' : 'none';
}

// ===== UNLOCK HELPERS (local cache + server validation) =====
function getUnlocked() {
  return JSON.parse(localStorage.getItem('unlockedComponents') || '[]');
}

async function isUnlocked(templateId) {
  // First check local cache for speed
  const local = getUnlocked();
  if (local.includes(templateId)) return true;

  // If logged in, verify against Supabase
  if (!currentUser) return false;
  try {
    const { data, error } = await supabaseClient
      .from('purchases')
      .select('id')
      .eq('user_id', currentUser.id)
      .eq('template_id', templateId)
      .maybeSingle();
    if (error) throw error;
    if (data) {
      // Cache it locally for future
      unlockComponent(templateId);
      return true;
    }
    return false;
  } catch (err) {
    console.error('Error checking unlock status:', err);
    return false;
  }
}

function unlockComponent(templateId) {
  const unlocked = getUnlocked();
  if (!unlocked.includes(templateId)) {
    unlocked.push(templateId);
    localStorage.setItem('unlockedComponents', JSON.stringify(unlocked));
  }
}

async function syncPurchasesToLocal() {
  if (!currentUser) return;
  try {
    const { data, error } = await supabaseClient
      .from('purchases')
      .select('template_id')
      .eq('user_id', currentUser.id);
    if (error || !data) return;
    data.forEach((p) => unlockComponent(p.template_id));
  } catch (err) {
    console.error('Sync failed:', err);
  }
}

// ===== STORE FAILED TRANSACTIONS =====
function storeFailedTransaction(reference, templateId, userId) {
  const failed = JSON.parse(localStorage.getItem('failed_transactions') || '[]');
  failed.push({
    reference,
    template_id: templateId,
    user_id: userId,
    timestamp: new Date().toISOString()
  });
  localStorage.setItem('failed_transactions', JSON.stringify(failed));
}
/* ============================================================
   UI VAULT — SCRIPT — PART 3
   Purchase Flow (Single & Cart) – FIXED with Paystack Popup
   ============================================================ */

// ===== SINGLE PURCHASE =====
function buyComponent(template) {
  if (!currentUser) {
    window._pendingTemplate = template;
    openAuthModal('login');
    return;
  }
  proceedToSingleCheckout(template);
}
function proceedToSingleCheckout(template) {
  if (typeof PaystackPop === 'undefined') {
    showToast('Loading payment library...');
    const script = document.createElement('script');
    script.src = 'https://js.paystack.co/v1/inline.js';
    script.onload = () => {
      showToast('Payment library loaded. Retrying...');
      proceedToSingleCheckout(template);
    };
    script.onerror = () => {
      showToast('Failed to load payment library. Check your internet.');
    };
    document.head.appendChild(script);
    return;
  }

  const amount = template.price * 100; // in kobo
  const ref = 'TMPL_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);

  try {
    const handler = PaystackPop.setup({
      key: CONFIG.PAYSTACK_PUBLIC_KEY,
      email: currentUser.email,
      amount: amount,
      currency: 'NGN',
      ref: ref,
      callback: function(response) {
        // Wrap async in IIFE
        (async function() {
          showToast('Verifying payment securely...');
          try {
            // Get current session token for secure Edge Function call
            const { data: sessionData } = await supabaseClient.auth.getSession();
            const session = sessionData.session;

            // Call your secure backend Edge Function
            const verifyRes = await fetch(CONFIG.SUPABASE_URL + '/functions/v1/verify-purchase', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + session?.access_token
              },
              body: JSON.stringify({
                reference: response.reference || ref,
                template_ids: [template.id],
                user_id: currentUser.id,
                cart_total: template.price
              })
            });
            
            const verifyResult = await verifyRes.json();

            if (verifyResult.success) {
              unlockComponent(template.id);
              showToast('Template unlocked! You can now download it from your Profile.');
              refreshCurrentView(template.id);
            } else {
              throw new Error(verifyResult.error || 'Backend verification failed.');
            }
          } catch (err) {
            console.error('Failed to verify purchase:', err);
            storeFailedTransaction(response.reference, template.id, currentUser.id);
            showToast('Verification failed. Contact support with ref: ' + response.reference);
          }
        })();
      },
      onClose: function() {
        showToast('Payment cancelled');
      }
    });
    handler.openIframe();
  } catch (err) {
    console.error('Paystack setup error:', err);
    showToast('Payment setup failed: ' + err.message);
  }
}


// ===== HANDLE PURCHASE RETURN (for legacy redirects) =====
async function handlePurchaseReturn() {
  const urlParams = new URLSearchParams(window.location.search);
  const reference = urlParams.get('reference') || urlParams.get('trxref');
  const templateId = localStorage.getItem('pendingPurchase');
  const userId = localStorage.getItem('pendingUserId');

  if (reference && templateId && userId) {
    window.history.replaceState({}, document.title, window.location.pathname);
    showToast('Verifying your purchase...');
    try {
      const { data: sessionData } = await supabaseClient.auth.getSession();
      const session = sessionData.session;
      const verifyRes = await fetch(CONFIG.SUPABASE_URL + '/functions/v1/verify-purchase', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + session?.access_token
        },
        body: JSON.stringify({ reference, template_id: templateId, user_id: userId })
      });
      const verifyResult = await verifyRes.json();
      if (verifyResult.success) {
        unlockComponent(templateId);
        localStorage.removeItem('pendingPurchase');
        localStorage.removeItem('pendingUserId');
        showToast('Payment successful! Template unlocked.');
        refreshCurrentView(templateId);
        return;
      }
      // Fallback: try direct insert
      const { error } = await supabaseClient
        .from('purchases')
        .insert([{ user_id: userId, template_id: templateId, reference }]);
      if (error) throw error;
      unlockComponent(templateId);
      localStorage.removeItem('pendingPurchase');
      localStorage.removeItem('pendingUserId');
      showToast('Payment successful! Template unlocked.');
      refreshCurrentView(templateId);
    } catch (err) {
      console.error('Purchase recording failed:', err);
      storeFailedTransaction(reference, templateId, userId);
      showToast('Payment made but recording failed. Please contact support with Ref: ' + reference);
    }
  }
}

function refreshCurrentView(templateId) {
  if (currentDetailTemplate && currentDetailTemplate.id == templateId) {
    openDetailView(currentDetailTemplate);
  } else {
    runFilter();
  }
}
/* ============================================================
   UI VAULT — SCRIPT — PART 4
   Profile Panel – Load, Open, Close, Logout
   ============================================================ */

async function loadProfileList() {
  const list = document.getElementById('profileList');
  list.innerHTML = '<div class="profile-empty"><div class="profile-empty-icon"></div>Loading...</div>';

  try {
    const { data: purchases, error } = await supabaseClient
      .from('purchases')
      .select('template_id, created_at')
      .eq('user_id', currentUser.id)
      .order('created_at', { ascending: false });

    if (error) throw error;

    if (!purchases || purchases.length === 0) {
      list.innerHTML = '<div class="profile-empty"><div class="profile-empty-icon"></div>No owned templates yet.<br>Purchase a premium template to see it here.</div>';
      return;
    }

    const templateIds = purchases.map(p => p.template_id);
    const { data: templates, error: tError } = await supabaseClient
      .from('templates')
      .select('id, title, category, thumbnail_url, accent')
      .in('id', templateIds);

    if (tError) throw tError;

    const tMap = {};
    (templates || []).forEach(t => { tMap[t.id] = t; });

    list.innerHTML = '';
    purchases.forEach((purchase) => {
      const t = tMap[purchase.template_id];
      if (!t) return;
      const accent = t.accent || '#0066ff';
      const thumbHtml = t.thumbnail_url
        ? `<img src="${t.thumbnail_url}" alt="${t.title}" />`
        : `<div class="profile-thumb-placeholder">${t.category}</div>`;
      const date = new Date(purchase.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
      const item = document.createElement('div');
      item.className = 'profile-item';
      item.innerHTML = `
        <div class="profile-thumb" style="background:linear-gradient(135deg,${accent}15,${accent}08);">${thumbHtml}</div>
        <div class="profile-item-info">
          <p class="profile-item-title">${t.title}</p>
          <p class="profile-item-meta">${t.category} · ${date}</p>
        </div>
        <span class="profile-owned-badge">OWNED</span>
      `;
      item.addEventListener('click', () => {
        closeProfile();
        const full = TEMPLATES.find(tmpl => tmpl.id == t.id);
        if (full) openDetailView(full);
      });
      list.appendChild(item);
    });

    purchases.forEach(p => unlockComponent(p.template_id));

  } catch (err) {
    console.error('Failed to load profile:', err);
    list.innerHTML = '<div class="profile-empty">Failed to load. Try refreshing.</div>';
  }
}

async function openProfile() {
  if (!currentUser) return;
  const modal = document.getElementById('profileModal');
  const emailEl = document.getElementById('profileEmail');
  modal.hidden = false;
  document.body.style.overflow = 'hidden';
  emailEl.textContent = currentUser.email;
  await loadProfileList();
}

function closeProfile() {
  document.getElementById('profileModal').hidden = true;
  document.body.style.overflow = '';
}

async function logoutUser() {
  await supabaseClient.auth.signOut();
  currentUser = null;
  updateProfileNavLinks();
  closeProfile();
  showToast('Logged out successfully.');
}

// ===== EVENT BINDINGS =====
document.getElementById('navProfile').addEventListener('click', (e) => {
  e.preventDefault();
  document.getElementById('hamburger')?.classList.remove('open');
  document.getElementById('mobileNav')?.classList.remove('open');
  openProfile();
});

document.getElementById('mobileNavProfile').addEventListener('click', (e) => {
  e.preventDefault();
  document.getElementById('hamburger')?.classList.remove('open');
  document.getElementById('mobileNav')?.classList.remove('open');
  openProfile();
});

document.getElementById('profileClose').addEventListener('click', closeProfile);
document.getElementById('profileBackdrop').addEventListener('click', closeProfile);
document.getElementById('logoutBtn').addEventListener('click', logoutUser);

document.getElementById('refreshPurchasesBtn').addEventListener('click', async function() {
  const restore = showLoading(this, 'Refreshing...');
  await loadProfileList();
  restore();
  showToast('Purchases refreshed!');
});
/* ============================================================
   UI VAULT — SCRIPT — PART 5
   State, Filtering, Card Building, Rendering
   ============================================================ */

const state = {
  query: "",
  filter: "all",
  free: [],
  premium: [],
};

const searchInput = document.getElementById("searchInput");
const freeGrid = document.getElementById("freeGrid");
const premiumGrid = document.getElementById("premiumGrid");
const freeSectionLabel = document.getElementById("freeSectionLabel");
const premiumSectionLabel = document.getElementById("premiumSectionLabel");
const resultsCount = document.getElementById("resultsCount");
const emptyState = document.getElementById("emptyState");
const emptyTerm = document.getElementById("emptyTerm");
const filterBtns = document.querySelectorAll(".filter-btn");
const hamburger = document.getElementById("hamburger");
const mobileNav = document.getElementById("mobileNav");

function runFilter() {
  const q = state.query.trim().toLowerCase();
  const f = state.filter;
  let filtered = TEMPLATES.filter(t => {
    const categoryMatch = f === "all" || f === "free" || f === "premium" || t.category === f;
    const searchMatch = q === "" ||
      t.title.toLowerCase().includes(q) ||
      (t.description && t.description.toLowerCase().includes(q)) ||
      t.category.toLowerCase().includes(q) ||
      (t.tags && t.tags.some(tag => tag.toLowerCase().includes(q)));
    return categoryMatch && searchMatch;
  });

  if (f === "free") {
    state.free = filtered.filter(t => t.price === 0 || t.price === null || t.price === undefined);
    state.premium = [];
  } else if (f === "premium") {
    state.free = [];
    state.premium = filtered.filter(t => t.price > 0);
  } else {
    state.free = filtered.filter(t => t.price === 0 || t.price === null || t.price === undefined);
    state.premium = filtered.filter(t => t.price > 0);
  }
  renderGrid();
}

function buildCard(template, isPremium) {
  const card = document.createElement("div");
  card.className = `template-card ${isPremium ? 'paid' : ''}`;
  card.addEventListener('click', () => openDetailView(template));

  const accent = template.accent || '#0066ff';
  const imageUrl = template.thumbnail_url || '';
  const bgStyle = imageUrl
    ? `background-image:url(${imageUrl});background-size:cover;background-position:center;`
    : `background:linear-gradient(135deg,${accent}15,${accent}08);`;

  const tagMarkup = template.tags && Array.isArray(template.tags)
    ? template.tags.map(t => `<span class="card-tag">${t}</span>`).join("")
    : "";

  const premiumBadge = isPremium ? '<span class="paid-badge">PRO</span>' : '';

  card.innerHTML = `
    <div class="card-image" style="${bgStyle}display:flex;align-items:center;justify-content:center;position:relative;">
      ${!imageUrl ? `<span style="font-family:'DM Mono',monospace;font-size:0.75rem;color:${accent};font-weight:500;text-transform:uppercase;letter-spacing:0.1em;">// ${template.category}</span>` : ''}
      ${premiumBadge}
    </div>
    <div class="card-body">
      <div class="card-meta">${tagMarkup}</div>
      <h2 class="card-title">${template.title}</h2>
    </div>
  `;
  return card;
}

function renderGrid() {
  freeGrid.innerHTML = "";
  premiumGrid.innerHTML = "";
  const freeCount = state.free.length;
  const premiumCount = state.premium.length;
  const total = freeCount + premiumCount;
  resultsCount.innerHTML = `Showing <strong>${total}</strong> template${total !== 1 ? 's' : ''}`;

  if (total === 0) {
    emptyState.hidden = false;
    freeSectionLabel.hidden = true;
    premiumSectionLabel.hidden = true;
    if (emptyTerm) emptyTerm.textContent = state.query ? `"${state.query}"` : `in "${state.filter}"`;
    return;
  }
  emptyState.hidden = true;

  if (freeCount > 0) {
    freeSectionLabel.hidden = false;
    const frag = document.createDocumentFragment();
    state.free.forEach(t => frag.appendChild(buildCard(t, false)));
    freeGrid.appendChild(frag);
  } else {
    freeSectionLabel.hidden = true;
  }

  if (premiumCount > 0) {
    premiumSectionLabel.hidden = false;
    const frag = document.createDocumentFragment();
    state.premium.forEach(t => frag.appendChild(buildCard(t, true)));
    premiumGrid.appendChild(frag);
  } else {
    premiumSectionLabel.hidden = true;
  }
}

// ===== SEARCH & FILTER EVENTS =====
searchInput.addEventListener("input", (e) => { state.query = e.target.value; runFilter(); });
searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    searchInput.value = "";
    state.query = "";
    runFilter();
    searchInput.blur();
  }
});

filterBtns.forEach(btn => {
  btn.addEventListener("click", () => {
    filterBtns.forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    state.filter = btn.dataset.filter;
    runFilter();
  });
});

// ===== HAMBURGER =====
if (hamburger) {
  hamburger.addEventListener("click", () => {
    hamburger.classList.toggle("open");
    mobileNav.classList.toggle("open");
  });
}
if (mobileNav) {
  mobileNav.querySelectorAll("a").forEach(link => {
    link.addEventListener("click", () => {
      hamburger?.classList.remove("open");
      mobileNav.classList.remove("open");
    });
  });
}

// ===== SCROLL HELPERS =====
function scrollToSection(id) {
  const el = document.getElementById(id);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function bindNavLinks(freeId, premiumId, aboutId) {
  const navFree = document.getElementById(freeId);
  const navPremium = document.getElementById(premiumId);
  const navAbout = document.getElementById(aboutId);
  if (navFree) navFree.addEventListener('click', (e) => {
    e.preventDefault();
    hamburger?.classList.remove('open');
    mobileNav?.classList.remove('open');
    scrollToSection('freeSectionLabel');
  });
  if (navPremium) navPremium.addEventListener('click', (e) => {
    e.preventDefault();
    hamburger?.classList.remove('open');
    mobileNav?.classList.remove('open');
    scrollToSection('premiumSectionLabel');
  });
  if (navAbout) navAbout.addEventListener('click', (e) => {
    e.preventDefault();
    hamburger?.classList.remove('open');
    mobileNav?.classList.remove('open');
    scrollToSection('aboutSection');
  });
}

bindNavLinks('navFree', 'navPremium', 'navAbout');
bindNavLinks('mobileNavFree', 'mobileNavPremium', 'mobileNavAbout');
/* ============================================================
   UI VAULT — SCRIPT — PART 6
   Copy, Download, Preview, Detail View (with Add to Cart)
   ============================================================ */

async function copyCode(templateId) {
  const template = TEMPLATES.find(t => t.id === templateId);
  if (!template) return;
  const code = '\n' + (template.html_content || '') + '\n\n<style>\n' + (template.css_content || '') + '\n</style>\n\n<script>\n' + (template.js_content || '') + '\n<\/script>';
  try {
    await navigator.clipboard.writeText(code);
    showToast('Code copied to clipboard!');
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = code;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
    showToast('Code copied to clipboard!');
  }
}

async function downloadTemplate(templateId) {
  const template = TEMPLATES.find(t => t.id === templateId);
  if (!template || !template.file_path) {
    showToast('Download file not found. Contact support.');
    return;
  }
  try {
    const { data, error } = await supabaseClient
      .storage
      .from('websites')
      .createSignedUrl(template.file_path, 3600);
    if (error) throw error;
    window.location.href = data.signedUrl;
    showToast('Download starting...');
  } catch (err) {
    console.error('Download failed:', err);
    showToast('Download failed. Try again or contact support.');
  }
}

// ===== TOAST =====
function showToast(message) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 2000);
}

// ===== PREVIEW =====
async function openPreview(templateId) {
  const modal = document.getElementById('previewModal');
  const iframe = document.getElementById('previewIframe');
  const loading = document.getElementById('previewLoading');
  const errorDiv = document.getElementById('previewError');
  if (!modal || !iframe) return;
  modal.hidden = false;
  document.body.style.overflow = 'hidden';
  if (loading) loading.hidden = false;
  if (errorDiv) errorDiv.hidden = true;
  try {
    const { data, error } = await supabaseClient
      .from('templates')
      .select('html_content, css_content, js_content, title')
      .eq('id', templateId)
      .single();
    if (error) throw error;
    if (!data) throw new Error('Template not found');

    const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
    const html = stripDocumentWrapper(data.html_content || '');
    const css = data.css_content || '';
    const js = data.js_content || '';
    const title = escapeHtml(data.title || 'Preview');

    iframeDoc.open();
    iframeDoc.write(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${title}</title><style>*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;padding:24px;background:#fff;color:#050505;line-height:1.6}${css}</style></head><body>${html}<script>(function(){document.addEventListener('DOMContentLoaded',function(){try{${js}}catch(e){console.error(e);var d=document.createElement('div');d.style.cssText='color:#e11d48;padding:16px;margin-top:16px;background:#fef2f2;border-radius:8px;font-family:monospace;font-size:13px;';d.textContent='JS Error: '+e.message;document.body.appendChild(d);}});})();<\/script></body></html>`);
    iframeDoc.close();
    if (loading) loading.hidden = true;
  } catch (err) {
    console.error('Preview failed:', err);
    if (loading) loading.hidden = true;
    if (errorDiv) { errorDiv.hidden = false; errorDiv.textContent = err.message; }
  }
}

function closePreview() {
  const modal = document.getElementById('previewModal');
  const iframe = document.getElementById('previewIframe');
  if (modal) { modal.hidden = true; document.body.style.overflow = ''; }
  if (iframe) iframe.src = 'about:blank';
}

function stripDocumentWrapper(html) {
  if (!html) return '';
  let cleaned = html.replace(/<!DOCTYPE[^>]*>/i, '');
  const bodyMatch = cleaned.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (bodyMatch) cleaned = bodyMatch[1];
  cleaned = cleaned.replace(/<\/?html[^>]*>/gi, '').replace(/<\/?head[^>]*>[\s\S]*?<\/head>/gi, '').replace(/<\/?body[^>]*>/gi, '');
  return cleaned.trim();
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

document.getElementById('previewClose').addEventListener('click', closePreview);
document.getElementById('previewBackdrop').addEventListener('click', closePreview);

// ===== DETAIL VIEW =====
async function openDetailView(template) {
  currentDetailTemplate = template;
  document.getElementById('detailTitle').textContent = template.title;
  document.getElementById('detailDescription').textContent = template.description || 'No description available.';
  document.getElementById('detailCategoryBadge').textContent = template.category;

  const priceBadge = document.getElementById('detailPriceBadge');
  const buyBtn = document.getElementById('detailBuyBtn');
  const copyBtn = document.getElementById('detailCopyBtn');
  const previewBtn = document.getElementById('detailPreviewBtn');
  const addToCartBtn = document.getElementById('detailAddToCartBtn');

  // Price line
  let priceLine = document.querySelector('.detail-header .template-price');
  if (!priceLine) {
    priceLine = document.createElement('p');
    priceLine.className = 'template-price';
    document.getElementById('detailTitle').insertAdjacentElement('afterend', priceLine);
  }

  if (template.price > 0) {
    priceBadge.style.display = 'none';
    priceLine.textContent = `Price: ₦${Number(template.price).toLocaleString('en-NG')}`;

    const owned = await isUnlocked(template.id);
    if (owned) {
      buyBtn.hidden = true;
      copyBtn.hidden = false;
      copyBtn.textContent = template.file_path ? 'Download ZIP' : 'Copy Code';
      previewBtn.textContent = "Preview Owned Template";
      addToCartBtn.hidden = true;
    } else {
      buyBtn.hidden = false;
      copyBtn.hidden = true;
      previewBtn.textContent = "Live Preview";
      addToCartBtn.hidden = false;
    }
  } else {
    priceBadge.style.display = 'none';
    priceBadge.textContent = 'Free';
    priceBadge.className = 'card-tag free-tag';
    buyBtn.hidden = true;
    copyBtn.hidden = false;
    copyBtn.textContent = template.file_path ? 'Download ZIP' : 'Copy Code';
    previewBtn.textContent = "Live Preview";
    addToCartBtn.hidden = true;
    priceLine.textContent = 'Free';
  }

  document.querySelector('.grid-container').hidden = true;
  document.querySelector('.search-zone').hidden = true;
  document.getElementById('templateDetailView').hidden = false;
  window.scrollTo(0, 0);
}

document.getElementById('backToGridBtn').addEventListener('click', () => {
  document.getElementById('templateDetailView').hidden = true;
  document.querySelector('.grid-container').hidden = false;
  document.querySelector('.search-zone').hidden = false;
});

document.getElementById('detailPreviewBtn').addEventListener('click', () => {
  if (currentDetailTemplate) openPreview(currentDetailTemplate.id);
});

document.getElementById('detailBuyBtn').addEventListener('click', () => {
  if (currentDetailTemplate) buyComponent(currentDetailTemplate);
});

// ===== NEW: ADD TO CART BUTTON IN DETAIL VIEW =====
document.getElementById('detailAddToCartBtn').addEventListener('click', () => {
  if (currentDetailTemplate) {
    const t = currentDetailTemplate;
    addToCart(t.id, t.title, t.price);
  }
});

document.getElementById('detailCopyBtn').addEventListener('click', () => {
  if (!currentDetailTemplate) return;
  if (currentDetailTemplate.file_path) {
    downloadTemplate(currentDetailTemplate.id);
  } else {
    copyCode(currentDetailTemplate.id);
  }
});

// ===== ESCAPE KEY HANDLER =====
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const previewModal = document.getElementById('previewModal');
    if (previewModal && !previewModal.hidden) { closePreview(); return; }
    const authModal = document.getElementById('authModal');
    if (authModal && !authModal.hidden) { closeAuthModal(); return; }
    const profileModal = document.getElementById('profileModal');
    if (profileModal && !profileModal.hidden) { closeProfile(); return; }
    const browseModal = document.getElementById('browseModal');
    if (browseModal && browseModal.classList.contains('open')) { closeBrowseModal(); return; }
  }
});
/* ============================================================
   UI VAULT — SCRIPT — PART 7
   Auth Modal – Open, Close, Tabs, Login, Signup
   ============================================================ */

function openAuthModal(defaultTab) {
  const modal = document.getElementById('authModal');
  modal.hidden = false;
  document.body.style.overflow = 'hidden';
  switchAuthTab(defaultTab || 'login');
  clearAuthErrors();
}

function closeAuthModal() {
  const modal = document.getElementById('authModal');
  modal.hidden = true;
  document.body.style.overflow = '';
}

function switchAuthTab(tab) {
  document.querySelectorAll('.auth-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === tab);
    t.setAttribute('aria-selected', t.dataset.tab === tab);
  });
  document.getElementById('formLogin').hidden = tab !== 'login';
  document.getElementById('formSignup').hidden = tab !== 'signup';
  clearAuthErrors();
}

function clearAuthErrors() {
  const loginErr = document.getElementById('loginError');
  const signupErr = document.getElementById('signupError');
  if (loginErr) { loginErr.hidden = true; loginErr.textContent = ''; }
  if (signupErr) { signupErr.hidden = true; signupErr.textContent = ''; }
}

function showAuthError(id, message) {
  const el = document.getElementById(id);
  if (el) { el.textContent = message; el.hidden = false; }
}

function setSubmitLoading(btnId, loading) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.disabled = loading;
  btn.textContent = loading ? 'Please wait…' : (btnId === 'loginSubmit' ? 'Log In' : 'Create Account');
}

// ===== EYE TOGGLE =====
document.querySelectorAll('.eye-btn').forEach(btn => {
  btn.addEventListener('click', function() {
    const input = document.getElementById(this.dataset.target);
    const eyeOff = this.querySelector('.eye-off');
    const eyeOn = this.querySelector('.eye-on');
    if (!input) return;
    if (input.type === 'password') {
      input.type = 'text';
      eyeOff.hidden = true;
      eyeOn.hidden = false;
    } else {
      input.type = 'password';
      eyeOff.hidden = false;
      eyeOn.hidden = true;
    }
  });
});

// ===== TAB SWITCHING =====
document.querySelectorAll('.auth-tab').forEach(tab => {
  tab.addEventListener('click', () => switchAuthTab(tab.dataset.tab));
});

document.querySelectorAll('.auth-switch-link').forEach(link => {
  link.addEventListener('click', () => switchAuthTab(link.dataset.switch));
});

document.getElementById('authClose').addEventListener('click', closeAuthModal);
document.getElementById('authBackdrop').addEventListener('click', closeAuthModal);

// ===== LOGIN =====
document.getElementById('loginSubmit').addEventListener('click', async function() {
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;

  if (!checkRateLimit(email)) {
    showAuthError('loginError', 'Too many attempts. Please wait.');
    return;
  }

  if (!email || !password) { showAuthError('loginError', 'Please enter your email and password.'); return; }
  setSubmitLoading('loginSubmit', true);
  clearAuthErrors();
  try {
    const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (error) throw error;
    closeAuthModal();
    showToast('Welcome back!');
    await syncPurchasesToLocal();

    // Resume pending actions
    if (window._pendingCartCheckout) {
      window._pendingCartCheckout = null;
      openCheckout();
      return;
    }
    if (window._pendingTemplate) {
      const t = window._pendingTemplate;
      window._pendingTemplate = null;
      proceedToSingleCheckout(t);
    }
  } catch (err) {
    showAuthError('loginError', err.message || 'Login failed. Check your email and password.');
  } finally {
    setSubmitLoading('loginSubmit', false);
  }
});

// ===== SIGNUP =====
document.getElementById('signupSubmit').addEventListener('click', async function() {
  const email = document.getElementById('signupEmail').value.trim();
  const password = document.getElementById('signupPassword').value;

  if (!checkRateLimit(email)) {
    showAuthError('signupError', 'Too many attempts. Please wait.');
    return;
  }

  if (!email || !password) { showAuthError('signupError', 'Please enter your email and password.'); return; }
  if (password.length < 6) { showAuthError('signupError', 'Password must be at least 6 characters.'); return; }

  setSubmitLoading('signupSubmit', true);
  clearAuthErrors();
  try {
    const { data, error } = await supabaseClient.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: null }
    });
    if (error) throw error;

    if (data?.session) {
      closeAuthModal();
      showToast('Account created! Welcome to Kuvwy.');
      if (window._pendingCartCheckout) {
        window._pendingCartCheckout = null;
        openCheckout();
        return;
      }
      if (window._pendingTemplate) {
        const t = window._pendingTemplate;
        window._pendingTemplate = null;
        proceedToSingleCheckout(t);
      }
    } else {
      showAuthError('signupError', 'Check your email to confirm your account, then log in.');
      setSubmitLoading('signupSubmit', false);
    }
  } catch (err) {
    showAuthError('signupError', err.message || 'Sign up failed. Try again.');
    setSubmitLoading('signupSubmit', false);
  }
});
/* ============================================================
   UI VAULT — SCRIPT — PART 8
   Cart System – Persistence, Add, Remove, Update UI
   ============================================================ */

// ===== PERSISTENCE =====
function saveCartToLocalStorage() {
  try {
    localStorage.setItem('kuvwy_cart', JSON.stringify(cart));
  } catch (e) { /* ignore */ }
}

function loadCartFromLocalStorage() {
  try {
    const stored = localStorage.getItem('kuvwy_cart');
    if (stored) {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed)) cart = parsed;
      else cart = [];
    } else {
      cart = [];
    }
  } catch {
    cart = [];
  }
}

// ===== UPDATE UI =====
function updateCartUI() {
  let total = 0;
  let itemCount = 0;
  const cartItems = document.getElementById('cartItems');

  if (cartItems) {
    if (cart.length === 0) {
      cartItems.innerHTML = '<p class="cart-empty">Your cart is empty.</p>';
    } else {
      let html = '';
      for (const item of cart) {
        total += item.price;
        itemCount++;
        html += `
          <div class="cart-item">
            <div class="cart-item-info">
              <span class="cart-item-title">${item.title}</span>
              <span class="cart-item-price">₦${item.price.toLocaleString()}</span>
            </div>
            <button class="cart-item-remove" data-id="${item.id}">&times;</button>
          </div>
        `;
      }
      cartItems.innerHTML = html;
      cartItems.querySelectorAll('.cart-item-remove').forEach(btn => {
        btn.addEventListener('click', function() {
          const id = parseInt(this.dataset.id);
          removeFromCart(id);
        });
      });
    }
  }

  document.getElementById('cartTotal').textContent = '₦' + total.toLocaleString();
  document.getElementById('cartCount').textContent = itemCount;
  saveCartToLocalStorage();
}

// ===== ADD =====
function addToCart(id, title, price) {
  if (cart.some(item => item.id === id)) {
    showToast('Already in cart');
    return;
  }
  cart.push({ id, title, price });
  updateCartUI();
  showToast('Added to cart');
  openCart();
}

// ===== REMOVE =====
function removeFromCart(id) {
  cart = cart.filter(item => item.id !== id);
  updateCartUI();
  if (cart.length === 0) closeCart();
}

// ===== OPEN / CLOSE =====
function openCart() {
  document.getElementById('cartSidebar').classList.add('open');
  document.getElementById('cartOverlay').classList.add('active');
  document.body.style.overflow = 'hidden';
}

function closeCart() {
  document.getElementById('cartSidebar').classList.remove('open');
  document.getElementById('cartOverlay').classList.remove('active');
  document.body.style.overflow = '';
}

document.getElementById('cartBtn').addEventListener('click', () => {
  const sidebar = document.getElementById('cartSidebar');
  if (sidebar.classList.contains('open')) closeCart();
  else openCart();
});
document.getElementById('cartClose').addEventListener('click', closeCart);
document.getElementById('cartOverlay').addEventListener('click', closeCart);
/* ============================================================
   UI VAULT — SCRIPT — PART 9
   Browse Templates Modal – Select & Add Multiple
   ============================================================ */

let selectedTemplates = [];

function openBrowseModal() {
  document.getElementById('browseModal').classList.add('open');
  document.body.style.overflow = 'hidden';
  renderBrowseList();
}

function closeBrowseModal() {
  document.getElementById('browseModal').classList.remove('open');
  document.body.style.overflow = '';
}

function renderBrowseList() {
  const list = document.getElementById('browseList');
  if (!list) return;

  if (TEMPLATES.length === 0) {
    list.innerHTML = '<p class="browse-loading">Loading templates...</p>';
    return;
  }

  const cartIds = cart.map(item => item.id);
  const available = TEMPLATES.filter(t => t.price > 0 && !cartIds.includes(t.id));

  if (available.length === 0) {
    list.innerHTML = '<p class="browse-empty">All templates are already in your cart.</p>';
    return;
  }

  selectedTemplates = [];
  let html = '';
  for (const t of available) {
    html += `
      <div class="browse-item" data-id="${t.id}">
        <div class="browse-item-info">
          <span class="browse-item-title">${t.title}</span>
          <span class="browse-item-price">₦${Number(t.price).toLocaleString()}</span>
        </div>
        <div class="browse-item-check" data-id="${t.id}"></div>
      </div>
    `;
  }
  list.innerHTML = html;

  list.querySelectorAll('.browse-item').forEach(el => {
    el.addEventListener('click', function() {
      const id = parseInt(this.dataset.id);
      const check = this.querySelector('.browse-item-check');
      const idx = selectedTemplates.indexOf(id);
      if (idx === -1) {
        selectedTemplates.push(id);
        check.classList.add('selected');
      } else {
        selectedTemplates.splice(idx, 1);
        check.classList.remove('selected');
      }
    });
  });
}

document.getElementById('browseTemplatesBtn').addEventListener('click', openBrowseModal);
document.getElementById('browseClose').addEventListener('click', closeBrowseModal);
document.getElementById('browseOverlay').addEventListener('click', closeBrowseModal);

document.getElementById('browseDoneBtn').addEventListener('click', function() {
  if (selectedTemplates.length === 0) {
    showToast('No templates selected');
    return;
  }
  for (const id of selectedTemplates) {
    const t = TEMPLATES.find(tmpl => tmpl.id === id);
    if (t && t.price > 0) {
      addToCart(t.id, t.title, t.price);
    }
  }
  selectedTemplates = [];
  closeBrowseModal();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.getElementById('browseModal').classList.contains('open')) {
    closeBrowseModal();
  }
});
/* ============================================================
   UI VAULT — SCRIPT — PART 10
   Checkout – Cart (FIXED with dynamic Paystack popup)
   ============================================================ */

function openCheckout() {
  if (cart.length === 0) {
    showToast('Your cart is empty');
    return;
  }

  if (!currentUser) {
    window._pendingCartCheckout = true;
    openAuthModal('login');
    return;
  }

  closeCart();
  proceedToCartCheckout();
}

function closeCheckout() {
  document.getElementById('checkoutModal').classList.remove('open');
  document.body.style.overflow = '';
}

document.getElementById('checkoutBtn').addEventListener('click', openCheckout);
document.getElementById('checkoutClose').addEventListener('click', closeCheckout);
document.getElementById('checkoutOverlay').addEventListener('click', closeCheckout);

// ===== PROCEED TO CART CHECKOUT (PAYSTACK POPUP) =====
function proceedToCartCheckout() {
  if (typeof PaystackPop === 'undefined') {
    showToast('Loading payment library...');
    const script = document.createElement('script');
    script.src = 'https://js.paystack.co/v1/inline.js';
    script.onload = () => {
      showToast('Payment library loaded. Retrying...');
      proceedToCartCheckout();
    };
    script.onerror = () => { showToast('Failed to load payment library.'); };
    document.head.appendChild(script);
    return;
  }

  const total = cart.reduce((sum, item) => sum + item.price, 0);
  const amount = total * 100;
  const ref = 'CART_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);

  try {
    const handler = PaystackPop.setup({
      key: CONFIG.PAYSTACK_PUBLIC_KEY,
      email: currentUser.email,
      amount: amount,
      currency: 'NGN',
      ref: ref,
      callback: function(response) {
        (async function() {
          showToast('Verifying cart payment securely...');
          const items = cart.slice();
          if (items.length === 0) return;

          try {
            // Get current session token for secure Edge Function call
            const { data: sessionData } = await supabaseClient.auth.getSession();
            const session = sessionData.session;
            
            const templateIds = items.map(item => item.id);

            // Call your secure backend Edge Function
            const verifyRes = await fetch(CONFIG.SUPABASE_URL + '/functions/v1/verify-purchase', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + session?.access_token
              },
              body: JSON.stringify({
                reference: response.reference || ref,
                template_ids: templateIds,
                user_id: currentUser.id,
                cart_total: total
              })
            });

            const verifyResult = await verifyRes.json();

            if (verifyResult.success) {
              items.forEach(item => unlockComponent(item.id));
              cart = [];
              updateCartUI();
              closeCheckout();
              document.getElementById('checkoutForm').reset();
              showToast('All templates unlocked! You can now download them from your Profile.');
            } else {
               throw new Error(verifyResult.error || 'Backend verification failed.');
            }
          } catch (err) {
            console.error('Failed to verify purchases:', err);
            showToast('Verification failed. Contact support with ref: ' + response.reference);
            items.forEach(item => storeFailedTransaction(response.reference, item.id, currentUser.id));
          }
        })();
      },
      onClose: function() {
        showToast('Payment cancelled');
      }
    });
    handler.openIframe();
  } catch (err) {
    console.error('Paystack setup error:', err);
    showToast('Payment setup failed: ' + err.message);
  }
}


// ===== CHECKOUT FORM SUBMIT =====
document.getElementById('checkoutForm').addEventListener('submit', function(e) {
  e.preventDefault();
  if (cart.length === 0) {
    showToast('Your cart is empty');
    return;
  }
  const email = document.getElementById('checkoutEmail').value.trim();
  if (!email || !email.includes('@')) {
    showToast('Please enter a valid email address');
    return;
  }
  if (currentUser && email !== currentUser.email) {
    showToast('Please use the email associated with your account');
    return;
  }
  if (currentUser) {
    proceedToCartCheckout();
  } else {
    window._pendingCartCheckout = true;
    openAuthModal('login');
  }
});
/* ============================================================
   UI VAULT — SCRIPT — PART 11
   Online/Offline, Online Banner, Init App
   ============================================================ */

function showOnlineBanner(message = 'Online') {
  const existing = document.querySelector('.online-banner');
  if (existing) existing.remove();
  const banner = document.createElement('div');
  banner.className = 'online-banner';
  banner.style.cssText = `
    display:flex; align-items:center; justify-content:center; gap:8px;
    background-color:rgba(34,197,94,0.85); color:white;
    padding:6px 16px; border-radius:20px; font-family:sans-serif;
    font-size:13px; font-weight:600; position:fixed; bottom:15px;
    left:50%; transform:translateX(-50%) translateY(20px);
    z-index:9999; opacity:0; transition:opacity 0.3s ease, transform 0.3s ease;
    box-shadow:0 2px 8px rgba(0,0,0,0.2); backdrop-filter:blur(4px);
    pointer-events:none;
  `;
  banner.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
      <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55M5 12.55a10.94 10.94 0 0 1 5.17-2.39M10.71 5.05A16 16 0 0 1 22.56 9M1.42 9a15.91 15.91 0 0 1 4.7-2.88M8.53 16.11a6 6 0 0 1 6.95 0M12 20h.01"/>
    </svg>
    <span>${message}</span>
  `;
  document.body.appendChild(banner);
  requestAnimationFrame(() => {
    banner.style.opacity = '1';
    banner.style.transform = 'translateX(-50%) translateY(0)';
  });
  setTimeout(() => {
    banner.style.opacity = '0';
    banner.style.transform = 'translateX(-50%) translateY(20px)';
    setTimeout(() => banner.remove(), 400);
  }, 2500);
}

// ===== INITIALIZE APP =====
async function initializeApp() {
  // Load cart from localStorage
  loadCartFromLocalStorage();
  updateCartUI();

  // Set footer year
  const footerYear = document.getElementById('footerYear');
  if (footerYear) footerYear.textContent = new Date().getFullYear();

  // Offline/Online banner
  const offlineBanner = document.getElementById('offlineBanner');

  function updateOnlineStatus() {
    if (navigator.onLine) {
      offlineBanner.style.display = 'none';
    } else {
      offlineBanner.style.display = 'flex';
    }
  }

  window.addEventListener('online', () => {
    updateOnlineStatus();
    showOnlineBanner('Online');
    setTimeout(() => initializeApp(), 600); // re-fetch data
  });
  window.addEventListener('offline', updateOnlineStatus);
  updateOnlineStatus();

  // Offline mode: show cached templates
  if (!navigator.onLine) {
    resultsCount.innerHTML = 'You are offline. Please reconnect to load templates.';
    const cached = localStorage.getItem('cachedTemplates');
    if (cached) {
      try {
        TEMPLATES = JSON.parse(cached);
        resultsCount.innerHTML = 'Showing cached templates — you are offline.';
        runFilter();
      } catch { renderGrid(); }
    } else {
      renderGrid();
    }
    return;
  }

  // Online: fetch from Supabase
  try {
    resultsCount.innerHTML = 'UI Vault is loading…';
    const { data, error } = await supabaseClient
      .from('templates')
      .select('*');
    if (error) throw error;
    TEMPLATES = data || [];
    localStorage.setItem('cachedTemplates', JSON.stringify(TEMPLATES));
    await handlePurchaseReturn();
    runFilter();
  } catch (err) {
    console.error('Supabase connection failed:', err);
    resultsCount.innerHTML = 'Offline mode — showing <strong>0</strong> templates';
    renderGrid();
  }
}
/* ============================================================
   UI VAULT — SCRIPT — PART 12
   Final Kick-off
   ============================================================ */

// Everything starts here
initializeApp();